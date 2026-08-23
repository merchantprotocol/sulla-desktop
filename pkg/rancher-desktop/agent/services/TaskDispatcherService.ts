import { AbortService } from './AbortService';
import { resolvePullRequestHead } from './GitHubPullRequestHeadService';
import { GraphRegistry } from './GraphRegistry';
import { isInsideWindow } from './HeartbeatService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import { WorkTaskDispatchModel, type ClaimedDispatch, type VerificationVerdict } from '../database/models/WorkTaskDispatchModel';
import { extractAgentTurnOutcome } from '../tools/agents/agentTurnOutcome';
import { toolRegistry } from '../tools/registry';
import { findAgentDir } from '../utils/sullaPaths';

const CHECK_INTERVAL_MS = 60_000;
const LEASE_HEARTBEAT_MS = 120_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_AGENT_ID = 'opus-worker';
const DEFAULT_VERIFIER_AGENT_ID = 'codex-test';
const DEFAULT_VERIFIER_TIMEOUT_MINUTES = 45;
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

      await this.fillExecutionPool();
      await this.fillVerificationPool();
    } catch (err) {
      console.error('[TaskDispatcher] Dispatch check failed:', err);
    } finally {
      this.checking = false;
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

    let freeSlots = Math.max(0, concurrency - await WorkTaskDispatchModel.countRunning('execution'));
    while (freeSlots > 0 && this.initialized) {
      const claim = await WorkTaskDispatchModel.claimNext(agentId);
      if (!claim) break;
      this.runClaim(claim).catch(err => console.error('[TaskDispatcher] Worker promise failed:', err));
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
      this.runClaim(claim).catch(err => console.error('[TaskDispatcher] Verifier promise failed:', err));
      freeSlots -= 1;
    }
  }

  private async runClaim(claim: ClaimedDispatch): Promise<void> {
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
        state.messages.push({ role: 'user', content: this.buildWorkerPrompt(task, dispatch.id) });
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
        await this.finalizeClaim(claim, outcome.status, summary);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (dispatch.kind === 'verification') {
        await WorkTaskDispatchModel.failVerification(
          dispatch.id,
          verifierTimedOut ? 'verifier_timeout' : message.slice(0, 2_000),
        );
      } else {
        await this.finalizeClaim(claim, 'failed', message);
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
  ): Promise<void> {
    const { dispatch, task } = claim;
    const taskStatus = status === 'completed' ? 'in_review' : 'blocked';
    const result = status === 'failed' ? undefined : summary;
    const error = status === 'failed' ? summary : undefined;
    const comment = status === 'failed'
      ? `Dispatch ${ dispatch.id } failed: ${ summary }`
      : `Dispatch ${ dispatch.id } ${ status } via ${ dispatch.agent_id }.\n\n${ summary }`;

    const settled = await Promise.allSettled([
      WorkTaskDispatchModel.settle(dispatch.id, status, result, error),
      WorkItemsModel.addComment({ task_id: task.id, author: 'dispatcher', body: comment }),
      WorkItemsModel.updateTask(task.id, { status: taskStatus, assignee: 'heartbeat', actor: 'dispatcher' }),
    ]);

    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        console.error(`[TaskDispatcher] Could not finalize ${ dispatch.id }:`, outcome.reason);
      }
    }
  }

  private buildWorkerPrompt(task: WorkTaskRecord, dispatchId: string): string {
    return `You are the execution worker for Projects task ${ task.id }.

Title: ${ task.title }
Priority: ${ task.priority }
Project: ${ task.project_id }
Epic: ${ task.epic_id ?? '(none)' }
Dispatch: ${ dispatchId }

Description:
${ task.description || '(no description)' }

Execute the task autonomously to the reversible edge. Inspect the real state first. For code work, use an isolated worktree/feature branch, verify the change, commit it, push it through the Sulla GitHub tools, and open a draft PR when possible. Do not merge, deploy, spend money, send external communications, or perform destructive shared-system actions. End with a concise artifact-and-verification summary. If a truly irreversible dependency remains, return BLOCKED with the exact requirement; reversible uncertainty is yours to decide.`;
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
