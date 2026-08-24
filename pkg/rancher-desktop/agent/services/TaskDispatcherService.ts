import { Octokit } from '@octokit/rest';

import { AbortService } from './AbortService';
import { CanonicalArtifactCustodyService } from './CanonicalArtifactCustodyService';
import { resolvePullRequestHead } from './GitHubPullRequestHeadService';
import { GraphRegistry } from './GraphRegistry';
import { isInsideWindow } from './HeartbeatService';
import { getIntegrationService } from './IntegrationService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import {
  WorkTaskDispatchModel, type ClaimedDispatch, type VerificationVerdict, type WorkTaskDispatchEvidence,
} from '../database/models/WorkTaskDispatchModel';
import { WorkflowModel } from '../database/models/WorkflowModel';
import { EXECUTE_PROJECT_TODO_DEFINITION, EXECUTE_PROJECT_TODO_ID } from '../routines/core/executeProjectTodo';
import { extractAgentTurnOutcome } from '../tools/agents/agentTurnOutcome';
import { toolRegistry } from '../tools/registry';
import { findAgentDir } from '../utils/sullaPaths';
import { createPlaybookState } from '../workflow/WorkflowPlaybook';

import type { WorkflowPlaybookState } from '../workflow/types';

const CHECK_INTERVAL_MS = 60_000;
const LEASE_HEARTBEAT_MS = 120_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_AGENT_ID = 'opus-worker';
const DEFAULT_VERIFIER_AGENT_ID = 'codex-test';
const DEFAULT_VERIFIER_TIMEOUT_MINUTES = 45;
const DEFAULT_IN_PROGRESS_STALE_MINUTES = 360;
const DEFAULT_RECOVERY_BATCH_SIZE = 1;
const DEFAULT_RECOVERY_RETRY_CEILING = 3;
const VERIFIER_TOOLS = [
  'file_search', 'read_file',
  'git_status', 'git_diff', 'git_log', 'git_blame',
  'github_get_issue', 'github_get_pr', 'github_get_pr_files', 'github_check_runs',
] as const;

interface ParsedVerification {
  verdict:      VerificationVerdict;
  artifactSha:  string;
  summary:      string;
}
type ExecutionOwner = 'core-routine' | 'legacy';

let taskDispatcherServiceInstance: TaskDispatcherService | null = null;

export function getTaskDispatcherService(): TaskDispatcherService {
  taskDispatcherServiceInstance ??= new TaskDispatcherService();
  return taskDispatcherServiceInstance;
}

/**
 * Deterministic Projects dispatcher.
 *
 * Selection and ownership are PostgreSQL operations. The model only receives
 * an already-claimed task and executes it; it never decides which queue item
 * runs next or whether capacity should be filled.
 */
export class TaskDispatcherService {
  private initialized = false;
  private checking = false;
  private schedulerId: ReturnType<typeof setInterval> | null = null;
  private active = new Map<string, AbortService>();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // No graph promise survives a process/service restart. Release every live
    // database lease before taking new work so a crash cannot strand a task.
    const recovered = await WorkTaskDispatchModel.recoverStale(0);
    if (recovered.length > 0) {
      console.warn(`[TaskDispatcher] Recovered ${ recovered.length } orphaned dispatch(es)`);
    }

    await this.checkAndDispatch();
    this.schedulerId = setInterval(() => {
      this.checkAndDispatch().catch(err => console.error('[TaskDispatcher] Scheduled check failed:', err));
    }, CHECK_INTERVAL_MS);
    console.log('[TaskDispatcher] Mechanical dispatcher initialized');
  }

  async forceCheck(): Promise<void> {
    await this.checkAndDispatch();
  }

  destroy(): void {
    this.initialized = false;
    if (this.schedulerId) {
      clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
    for (const abort of this.active.values()) abort.abort();
    this.active.clear();
  }

  private async checkAndDispatch(): Promise<void> {
    if (!this.initialized || this.checking) return;
    this.checking = true;
    try {
      const enabled = await SullaSettingsModel.get('heartbeatEnabled', false);
      if (!enabled) return;

      const window = await SullaSettingsModel.get('heartbeatWindow', null);
      if (window && !isInsideWindow(window)) return;

      await this.checkInProgressRecovery();
      await this.fillExecutionPool();
      await this.fillVerificationPool();
    } catch (err) {
      console.error('[TaskDispatcher] Dispatch check failed:', err);
    } finally {
      this.checking = false;
    }
  }

  private async checkInProgressRecovery(): Promise<void> {
    const enabledSetting = await SullaSettingsModel.get('taskDispatcherInProgressRecoveryEnabled', false);
    const enabled = enabledSetting === true || enabledSetting === 'true';
    const staleConfigured = Number(await SullaSettingsModel.get(
      'taskDispatcherInProgressStaleMinutes', DEFAULT_IN_PROGRESS_STALE_MINUTES,
    ));
    const batchConfigured = Number(await SullaSettingsModel.get(
      'taskDispatcherRecoveryBatchSize', DEFAULT_RECOVERY_BATCH_SIZE,
    ));
    const ceilingConfigured = Number(await SullaSettingsModel.get(
      'taskDispatcherRecoveryRetryCeiling', DEFAULT_RECOVERY_RETRY_CEILING,
    ));
    const staleMinutes = Math.max(15, staleConfigured || DEFAULT_IN_PROGRESS_STALE_MINUTES);
    const batchSize = Math.max(1, Math.min(25, batchConfigured || DEFAULT_RECOVERY_BATCH_SIZE));
    const retryCeiling = Math.max(1, Math.min(10, ceilingConfigured || DEFAULT_RECOVERY_RETRY_CEILING));
    const candidates = await WorkTaskDispatchModel.findRecoverableInProgress(staleMinutes, 100);

    for (const candidate of candidates.filter(item => item.exclusionReasons.length === 0 && item.task.github_issue)) {
      if (await this.hasActiveLinkedPullRequest(candidate.task.github_issue!)) {
        candidate.exclusionReasons.push('linked_external_operation');
      }
    }

    const eligible = candidates.filter(candidate => candidate.exclusionReasons.length === 0);
    const excludedCounts = candidates.flatMap(candidate => candidate.exclusionReasons)
      .reduce<Record<string, number>>((counts, reason) => {
        counts[reason] = (counts[reason] || 0) + 1;
        return counts;
      }, {});
    console.log('[TaskDispatcher] In-progress recovery report', {
      mode:     enabled ? 'enabled' : 'report-only',
      scanned:  candidates.length,
      eligible: eligible.length,
      excluded: excludedCounts,
      staleMinutes,
      batchSize,
      retryCeiling,
    });

    if (!enabled || eligible.length === 0) return;
    const recovered = await WorkTaskDispatchModel.recoverOrphanedInProgress(eligible, batchSize, retryCeiling);
    const counts = recovered.reduce<Record<string, number>>((outcomes, result) => {
      outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1;
      return outcomes;
    }, {});
    console.warn('[TaskDispatcher] In-progress recovery outcomes', counts);
  }

  private async hasActiveLinkedPullRequest(reference: string): Promise<boolean> {
    const match = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/#\s]+?)(?:\/pull\/|#)(\d+)$/i.exec(reference.trim());
    if (!match) return false;
    try {
      const token = await getIntegrationService().getIntegrationValue('github', 'token');
      if (!token) return true;
      const octokit = new Octokit({ auth: token.value });
      const { data } = await octokit.pulls.get({
        owner: match[1], repo: match[2], pull_number: Number(match[3]),
      });
      return data.state === 'open';
    } catch (err: any) {
      if (err?.status === 404) return false;
      console.warn(`[TaskDispatcher] Linked PR check failed for ${ reference }; excluding candidate`, err);
      return true;
    }
  }

  private async fillExecutionPool(): Promise<void> {
    const configured = Number(await SullaSettingsModel.get('taskDispatcherConcurrency', DEFAULT_CONCURRENCY));
    const concurrency = Math.max(1, Math.min(10, configured || DEFAULT_CONCURRENCY));
    const agentId = String(await SullaSettingsModel.get('taskDispatcherAgentId', DEFAULT_AGENT_ID)).trim() || DEFAULT_AGENT_ID;
    if (!findAgentDir(agentId)) {
      console.error(`[TaskDispatcher] Agent config "${ agentId }" does not exist; execution paused`);
      return;
    }

    const executionOwner = await this.resolveExecutionOwner();
    if (!executionOwner) return;

    let freeSlots = Math.max(0, concurrency - await WorkTaskDispatchModel.countRunning('execution'));
    while (freeSlots > 0 && this.initialized) {
      const claim = await WorkTaskDispatchModel.claimNext(
        agentId, executionOwner === 'core-routine' ? 'core-todo' : 'legacy-worker');
      if (!claim) break;
      this.runClaim(claim, executionOwner).catch(err => console.error('[TaskDispatcher] Worker promise failed:', err));
      freeSlots -= 1;
    }
  }

  private async fillVerificationPool(): Promise<void> {
    const enabled = await SullaSettingsModel.get('taskVerifierEnabled', false);
    if (!enabled) return;
    const configured = Number(await SullaSettingsModel.get('taskVerifierConcurrency', DEFAULT_CONCURRENCY));
    const concurrency = Math.max(1, Math.min(10, configured || DEFAULT_CONCURRENCY));
    const agentId = String(await SullaSettingsModel.get('taskVerifierAgentId', DEFAULT_VERIFIER_AGENT_ID)).trim() || DEFAULT_VERIFIER_AGENT_ID;
    if (!findAgentDir(agentId)) {
      console.error(`[TaskDispatcher] Agent config "${ agentId }" does not exist; verification paused`);
      return;
    }

    let freeSlots = Math.max(0, concurrency - await WorkTaskDispatchModel.countRunning('verification'));
    while (freeSlots > 0 && this.initialized) {
      const claim = await WorkTaskDispatchModel.claimNextReview(agentId);
      if (!claim) break;
      this.runClaim(claim, 'legacy').catch(err => console.error('[TaskDispatcher] Verifier promise failed:', err));
      freeSlots -= 1;
    }
  }

  /**
   * One scheduler and one database claim path own todo. The core routine is
   * activated only by `taskDispatcherExecutionOwner=core-routine`; legacy is
   * the dark-rollout default. Once core owns dispatch, disabling the locked
   * routine pauses claims instead of starting a second owner beside it.
   */
  private async resolveExecutionOwner(): Promise<ExecutionOwner | null> {
    const configured = String(await SullaSettingsModel.get('taskDispatcherExecutionOwner', 'legacy'));
    if (configured === 'legacy') return 'legacy';

    const routine = await WorkflowModel.findById(EXECUTE_PROJECT_TODO_ID);
    if (!routine || routine.attributes.enabled === false) return null;
    return 'core-routine';
  }

  private async runClaim(claim: ClaimedDispatch, executionOwner: ExecutionOwner): Promise<void> {
    const { dispatch, task } = claim;
    const abort = new AbortService();
    this.active.set(dispatch.id, abort);
    const leaseTimer = setInterval(
      () => {
        WorkTaskDispatchModel.touch(dispatch.id)
          .catch(err => console.error(`[TaskDispatcher] Lease refresh failed for ${ dispatch.id }:`, err));
      },
      LEASE_HEARTBEAT_MS,
    );
    let verifierTimeout: ReturnType<typeof setTimeout> | null = null;
    let verifierTimedOut = false;

    try {
      const isVerification = dispatch.kind === 'verification';
      await WorkItemsModel.addComment({
        task_id: task.id,
        author:  'dispatcher',
        body:    `${ isVerification ? 'Verification' : 'Mechanical dispatch' } started with ${ dispatch.agent_id } (dispatch ${ dispatch.id }, attempt ${ dispatch.attempt || 1 }).`,
      }).catch(err => console.error(`[TaskDispatcher] Could not write start comment for ${ dispatch.id }:`, err));
      const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(
        dispatch.agent_id,
        dispatch.thread_id,
        { isTrustedUser: 'trusted' },
      ) as { graph: any; state: any };
      const comments = isVerification ? await WorkItemsModel.listComments(task.id) : [];

      if (isVerification) {
        state.messages.push({ role: 'user', content: this.buildVerifierPrompt(task, dispatch.id, comments) });
        const llmTools = await Promise.all(VERIFIER_TOOLS.map(name => toolRegistry.convertToolToLLM(name)));
        state.llmTools = llmTools;
        state.metadata.allowedToolNames = [...VERIFIER_TOOLS];
        state.metadata.verifierReadOnly = true;
      } else {
        const taskPrompt = await this.buildWorkerPrompt(task, dispatch.id, executionOwner);
        state.messages.push({ role: 'user', content: taskPrompt });
        if (executionOwner === 'core-routine') {
          const playbook = createPlaybookState(EXECUTE_PROJECT_TODO_DEFINITION as any, taskPrompt);
          state.metadata.activeWorkflow = playbook;
          await WorkTaskDispatchModel.recordEvidence(dispatch.id, { workflowExecutionId: playbook.executionId });
          try {
            const { WorkflowExecutionModel } = await import('../database/models/WorkflowExecutionModel');
            await WorkflowExecutionModel.markRunning({
              executionId:  playbook.executionId,
              workflowId:   EXECUTE_PROJECT_TODO_ID,
              workflowName: EXECUTE_PROJECT_TODO_DEFINITION.name,
              workflowSlug: EXECUTE_PROJECT_TODO_ID,
              triggerInput: taskPrompt,
            });
          } catch (err) {
            console.warn(`[TaskDispatcher] Could not record workflow execution ${ playbook.executionId }:`, err);
          }
        }
      }
      state.metadata.isSubAgent = true;
      state.metadata.subAgentDepth = 1;
      state.metadata.workflowParentChannel = 'task-dispatcher';
      state.metadata.options ??= {};
      state.metadata.options.abort = abort;

      const timeoutMinutes = isVerification
        ? Math.max(1, Number(await SullaSettingsModel.get('taskVerifierTimeoutMinutes', DEFAULT_VERIFIER_TIMEOUT_MINUTES)) || DEFAULT_VERIFIER_TIMEOUT_MINUTES)
        : 0;
      verifierTimeout = isVerification
        ? setTimeout(() => {
          verifierTimedOut = true;
          abort.abort();
        }, timeoutMinutes * 60_000)
        : null;
      const finalState = await graph.execute(state);
      if (verifierTimeout) clearTimeout(verifierTimeout);
      const outcome = extractAgentTurnOutcome(finalState);
      const summary = outcome.text.slice(0, 8_000);

      if (isVerification) {
        if (verifierTimedOut) {
          await WorkTaskDispatchModel.failVerification(dispatch.id, 'verifier_timeout');
        } else {
          const parsed = this.parseVerification(summary);
          if (!parsed) {
            await WorkTaskDispatchModel.failVerification(dispatch.id, 'malformed_verifier_output');
          } else {
            const currentHead = parsed.verdict === 'APPROVE'
              ? await resolvePullRequestHead(task.github_issue, comments)
              : null;
            if (parsed.verdict === 'APPROVE' && !currentHead) {
              await WorkTaskDispatchModel.failVerification(dispatch.id, 'pull_request_artifact_unresolved');
            } else if (currentHead && currentHead.sha !== parsed.artifactSha) {
              await WorkTaskDispatchModel.failVerification(
                dispatch.id,
                `artifact_head_changed:${ parsed.artifactSha }:${ currentHead.sha }`,
              );
            } else {
              await WorkTaskDispatchModel.finalizeVerification(
                dispatch.id, parsed.verdict, parsed.artifactSha, currentHead?.sha ?? null, parsed.summary,
              );
            }
          }
        }
      } else {
        await this.finalizeClaim(claim, outcome.status, summary, executionOwner, finalState.metadata?.activeWorkflow);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (dispatch.kind === 'verification') {
        await WorkTaskDispatchModel.failVerification(
          dispatch.id,
          verifierTimedOut ? 'verifier_timeout' : message.slice(0, 2_000),
        );
      } else {
        await this.finalizeClaim(claim, 'failed', message, executionOwner);
      }
    } finally {
      if (verifierTimeout) clearTimeout(verifierTimeout);
      clearInterval(leaseTimer);
      this.active.delete(dispatch.id);
      GraphRegistry.delete(dispatch.thread_id);
      if (this.initialized) {
        this.checkAndDispatch().catch(err => console.error('[TaskDispatcher] Refill check failed:', err));
      }
    }
  }

  private parseVerification(output: string): ParsedVerification | null {
    const matches = [...output.matchAll(/<VERIFIER_RESULT>([\s\S]*?)<\/VERIFIER_RESULT>/g)];
    if (matches.length !== 1) return null;
    try {
      const parsed = JSON.parse(matches[0][1].trim());
      if (!parsed || !['APPROVE', 'REWORK', 'BLOCKED'].includes(parsed.verdict)) return null;
      if (typeof parsed.artifact_sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(parsed.artifact_sha)) return null;
      if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
      return {
        verdict: parsed.verdict,
        artifactSha: parsed.artifact_sha.toLowerCase(),
        summary: parsed.summary.trim().slice(0, 8_000),
      };
    } catch {
      return null;
    }
  }

  private async finalizeClaim(
    claim: ClaimedDispatch,
    status: 'completed' | 'blocked' | 'failed',
    summary: string,
    executionOwner: ExecutionOwner,
    playbook?: WorkflowPlaybookState,
  ): Promise<void> {
    const { dispatch, task } = claim;
    const evidence = playbook ? await this.extractWorkflowEvidence(playbook, task) : null;
    const coreContractMissing = executionOwner === 'core-routine' && !evidence;
    const taskStatus = status === 'failed' || coreContractMissing
      ? 'planning'
      : status === 'completed'
        ? evidence?.nextState ?? 'in_review'
        : evidence?.nextState === 'blocked' ? 'blocked' : 'planning';
    const assignee = taskStatus === 'planning' ? 'dispatcher' : 'heartbeat';
    const dispatchStatus = status === 'failed' || coreContractMissing || evidence?.contractValid === false
      ? 'failed'
      : taskStatus === 'blocked' ? 'blocked' : 'completed';
    const contractError = coreContractMissing
      ? 'core routine returned without structured acceptance and custody evidence'
      : evidence?.contractError;
    const result = dispatchStatus === 'failed' ? undefined : summary;
    const error = dispatchStatus === 'failed' ? contractError || summary : undefined;
    const comment = dispatchStatus === 'failed'
      ? `Dispatch ${ dispatch.id } requires replanning: ${ error }`
      : [
        `Dispatch ${ dispatch.id } ${ status } via ${ dispatch.agent_id }.`,
        evidence?.proposedComment,
        evidence?.ledger.artifactUrl || evidence?.ledger.artifactLocation
          ? `Canonical artifact: ${ evidence.ledger.artifactUrl || evidence.ledger.artifactLocation } @ ${ evidence.ledger.contentHash || evidence.ledger.artifactRef || 'verified' }`
          : null,
        summary,
      ].filter(Boolean).join('\n\n');

    const committed = await WorkTaskDispatchModel.finalize(dispatch.id, task.id, {
      dispatchStatus,
      taskStatus,
      taskAssignee: assignee,
      comment,
      result,
      error,
      evidence:     evidence?.ledger,
    });

    if (taskStatus === 'planning') {
      const { PlanningCouncilService } = await import('./PlanningCouncilService');
      await PlanningCouncilService.handleTaskStatusTransition(committed, 'in_progress', 'dispatcher');
    }
  }

  private parseJsonResult(value: unknown): Record<string, any> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
    if (typeof value !== 'string') return null;
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(value.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  private async extractWorkflowEvidence(playbook: WorkflowPlaybookState, task: WorkTaskRecord): Promise<{
    ledger:           WorkTaskDispatchEvidence;
    nextState:        'in_review' | 'planning' | 'blocked';
    contractValid:    boolean;
    contractError?:   string;
    proposedComment?: string;
  }> {
    const output = (id: string) => this.parseJsonResult(playbook.nodeOutputs[id]?.result);
    const classifier = output('node-todo-classify');
    const workers = output('node-todo-workers');
    const review = output('node-todo-review');
    const repair = output('node-todo-repair');
    const custody = output('node-todo-custody');
    const record = output('node-todo-record');
    const custodyVerdict = String(custody?.verdict || '').toLowerCase();
    const repairRoute = String(repair?.route || '').toLowerCase();
    const reviewerVerdict = String(custody?.reviewerVerdict || review?.verdict || '').toLowerCase();
    const hasReviewEvidence = review?.evidence !== undefined && review?.evidence !== null && JSON.stringify(review.evidence).length > 2;
    const hasVerification = custody?.verificationEvidence !== undefined && custody?.verificationEvidence !== null && JSON.stringify(custody.verificationEvidence).length > 2;
    const proposedComment = String(record?.proposedComment || '').trim();
    const passProposal = custodyVerdict === 'pass' &&
      ['pass', 'repaired'].includes(repairRoute) &&
      reviewerVerdict === 'pass' &&
      hasReviewEvidence &&
      hasVerification &&
      record?.taskId === task.id &&
      record?.nextState === 'in_review' &&
      proposedComment.length > 0;
    const explicitExternalBlock = custodyVerdict === 'blocked' &&
      repairRoute === 'blocked' &&
      Boolean(custody?.terminalReason) &&
      hasReviewEvidence;
    let canonical = null;
    let canonicalError: string | undefined;
    if (passProposal) {
      try {
        canonical = await CanonicalArtifactCustodyService.verify(task, custody || {}, record || {});
        canonicalError = canonical.valid ? undefined : canonical.error;
      } catch (err) {
        canonicalError = `canonical artifact verification failed: ${ err instanceof Error ? err.message : String(err) }`;
      }
    }
    const passContract = passProposal && canonical?.valid === true;
    const contractValid = passContract || explicitExternalBlock || repairRoute === 'replan';
    const contractError = contractValid
      ? undefined
      : canonicalError || 'structured review or durable artifact custody evidence is incomplete';
    const nextState = passContract
      ? 'in_review'
      : explicitExternalBlock
        ? 'blocked'
        : 'planning';

    return {
      nextState,
      contractValid,
      contractError,
      proposedComment: passContract ? proposedComment : undefined,
      ledger:          {
        workflowExecutionId: playbook.executionId,
        classifierDecision:  classifier ?? undefined,
        selectedAgents:      Array.isArray(classifier?.selectedAgents) ? classifier.selectedAgents : undefined,
        workerChildIds:      Array.isArray(workers?.childIds) ? workers.childIds.map(String) : undefined,
        reviewCount:         review ? 1 : 0,
        repairCount:         repairRoute === 'repaired' ? 1 : 0,
        artifactType:        custody?.artifactType,
        artifactLocation:    canonical?.artifactLocation || custody?.artifactLocation,
        artifactUrl:         canonical?.artifactUrl || custody?.artifactUrl,
        artifactRef:         canonical?.artifactRef || custody?.artifactRef || custody?.headSha,
        contentHash:         canonical?.contentHash || custody?.contentHash || custody?.headSha,
        reviewerVerdict,
        reviewEvidence:      review?.evidence ?? review ?? undefined,
        terminalReason:      custody?.terminalReason || contractError || (nextState === 'planning' ? 'acceptance_or_custody_incomplete' : undefined),
      },
    };
  }

  private async buildWorkerPrompt(task: WorkTaskRecord, dispatchId: string, executionOwner: ExecutionOwner): Promise<string> {
    const comments = await WorkItemsModel.listComments(task.id);
    const boundedComments = comments.slice(-50).map(comment => ({
      author:     comment.author,
      body:       comment.body.slice(0, 4_000),
      created_at: comment.created_at,
    }));

    return `You are executing the ${ executionOwner === 'core-routine' ? 'locked core todo routine' : 'legacy capability fallback' } for Projects task ${ task.id }.

Title: ${ task.title }
Priority: ${ task.priority }
Project: ${ task.project_id }
Epic: ${ task.epic_id ?? '(none)' }
Dispatch: ${ dispatchId }

Description:
${ task.description || '(no description)' }

Bounded task comments (oldest to newest, maximum 50):
${ JSON.stringify(boundedComments) }

The dispatcher already owns the atomic claim. Run classification, capability-based worker fan-out, independent artifact review, targeted repair or #667 planning handoff, and durable artifact custody. Coding work requires a verified commit, pushed branch, remote draft PR, exact head SHA, and URL. Non-code work requires an authoritative tracker artifact linked back to Projects. Do not mark the task done.`;
  }

  private buildVerifierPrompt(task: WorkTaskRecord, dispatchId: string, comments: { author: string | null; body: string }[]): string {
    const history = comments.map(comment => `- ${ comment.author || 'unknown' }: ${ comment.body }`).join('\n').slice(-24_000);
    return `You are the independent verification worker for Projects task ${ task.id }.

Title: ${ task.title }
Priority: ${ task.priority }
Project: ${ task.project_id }
Epic: ${ task.epic_id ?? '(none)' }
Verification dispatch: ${ dispatchId }
GitHub artifact hint: ${ task.github_issue ?? '(inspect task history)' }

Acceptance contract:
${ task.description || '(no description)' }

Dispatcher and task history:
${ history || '(no comments)' }

Review independently. Resolve the actual draft PR/branch and matching local worktree from the task and history. Read the current remote head through the GitHub tools, record the FULL exact head SHA, inspect the diff plus callers/consumers, map every acceptance criterion to evidence, and run focused tests/typecheck safely against the matching worktree. Include tenant, security, and regression analysis when relevant. Re-check the remote head immediately before your verdict; if it changed, do not approve until the matching new head is available and reviewed.

You are read-only with respect to the product and shared systems. Do not edit files, checkout/fetch, commit, push, merge, deploy, spend money, change Projects state, or send external communications. Read-only inspection and tests are allowed. The dispatcher alone applies the transition.

Choose exactly one verdict:
- APPROVE: the exact reviewed head satisfies the acceptance contract.
- REWORK: concrete, reversible defects or missing criteria remain.
- BLOCKED: only a genuinely external/irreversible dependency prevents completion.

Even for a BLOCKED verdict, use the normal completion wrapper around the machine block. Do not emit AGENT_BLOCKED; the dispatcher must receive and apply the structured verdict itself.

Your final response must contain exactly one machine block in this shape (the normal agent completion wrapper may surround it):
<VERIFIER_RESULT>{"verdict":"APPROVE|REWORK|BLOCKED","artifact_sha":"FULL_HEX_SHA","summary":"acceptance mapping, tests, and concrete findings"}</VERIFIER_RESULT>

Any missing block, unknown verdict, abbreviated/non-hex SHA, or malformed JSON is treated as a verifier failure and leaves the task in_review for retry.`;
  }
}
