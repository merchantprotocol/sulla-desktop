import { Octokit } from '@octokit/rest';

import { AbortService } from './AbortService';
import { resolvePullRequestHead, resolvePullRequestHeads } from './GitHubPullRequestHeadService';
import { GraphRegistry } from './GraphRegistry';
import { isInsideWindow } from './HeartbeatService';
import { LifecycleCapabilityModel } from '../database/models/LifecycleCapabilityModel';
import { getIntegrationService } from './IntegrationService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import {
  WorkTaskDispatchModel,
  type ClaimedDispatch,
  type ProtectedReviewEvidence,
  type ReviewArtifactComponent,
  type ReviewArtifactType,
  type ReviewDisposition,
  type VerificationVerdict,
} from '../database/models/WorkTaskDispatchModel';
import { WorkflowModel } from '../database/models/WorkflowModel';
import {
  REVIEW_PROJECT_ARTIFACT_DEFINITION,
  REVIEW_PROJECT_ARTIFACT_ID,
  ARTIFACT_VERIFICATION_ADAPTERS,
  REVIEWER_AGENT_IDS,
  REVIEWER_NODE_IDS,
} from '../routines/core/reviewProjectArtifact';
import { extractAgentTurnOutcome } from '../tools/agents/agentTurnOutcome';
import { toolRegistry } from '../tools/registry';
import { findAgentDir } from '../utils/sullaPaths';
import { createPlaybookState } from '../workflow/WorkflowPlaybook';

const CHECK_INTERVAL_MS = 60_000;
const LEASE_HEARTBEAT_MS = 120_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_AGENT_ID = 'opus-worker';
const RUNTIME_INSTANCE_ID = `task-dispatcher-${ process.pid }-${ Date.now() }`;
const DEFAULT_VERIFIER_AGENT_ID = 'codex-test';
const DEFAULT_VERIFIER_TIMEOUT_MINUTES = 45;
const DEFAULT_IN_PROGRESS_STALE_MINUTES = 360;
const DEFAULT_RECOVERY_BATCH_SIZE = 1;
const DEFAULT_RECOVERY_RETRY_CEILING = 3;
const LEGACY_VERIFIER_TOOLS = [
  'file_search', 'read_file',
  'git_status', 'git_diff', 'git_log', 'git_blame',
  'github_get_issue', 'github_get_pr', 'github_get_pr_files', 'github_check_runs',
] as const;
const PROTECTED_REVIEW_TOOLS = [...new Set([
  ...Object.values(ARTIFACT_VERIFICATION_ADAPTERS).flatMap(adapter => [...adapter.tools]),
])] as string[];

interface ParsedVerification {
  verdict:     VerificationVerdict;
  artifactSha: string;
  summary:     string;
}

interface ParsedProtectedReview extends Omit<ProtectedReviewEvidence, 'workflowExecutionId' | 'reviewerAgentIds' | 'excludedAgentIds'> {
  disposition: ReviewDisposition;
}

type VerificationOwner = 'core-routine' | 'legacy';

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
  private recoveredOnStart = false;
  private active = new Map<string, AbortService>();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await LifecycleCapabilityModel.recoverPreviousRuntime('todo-execution', RUNTIME_INSTANCE_ID);
    await LifecycleCapabilityModel.recoverPreviousRuntime('in-review-verification', RUNTIME_INSTANCE_ID);
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
    this.recoveredOnStart = false;
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
      if (!enabled) {
        await LifecycleCapabilityModel.report({
          key:               'todo-execution',
          enabled:           false,
          health:            'unavailable',
          owner:             null,
          runtimeInstanceId: RUNTIME_INSTANCE_ID,
          fallbackMode:      'manual_hold',
          error:             'Heartbeat and mechanical dispatch are disabled by user setting.',
        });
        return;
      }

      const window = await SullaSettingsModel.get('heartbeatWindow', null);
      if (window && !isInsideWindow(window)) return;

      if (!this.recoveredOnStart) {
        const recovered = await WorkTaskDispatchModel.recoverStale(0);
        this.recoveredOnStart = true;
        if (recovered.length > 0) console.warn(`[TaskDispatcher] Recovered ${ recovered.length } orphaned dispatch(es)`);
      }

      await this.checkInProgressRecovery();
      await this.fillExecutionPool();
      await this.fillVerificationPool();
    } catch (err) {
      console.error('[TaskDispatcher] Dispatch check failed:', err);
      await LifecycleCapabilityModel.report({
        key:               'todo-execution',
        enabled:           true,
        health:            'degraded',
        owner:             'dispatcher',
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        fallbackMode:      'heartbeat',
        error:             err instanceof Error ? err.message : String(err),
      }).catch(reportErr => console.error('[TaskDispatcher] Capability report failed:', reportErr));
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
      await LifecycleCapabilityModel.report({
        key:               'todo-execution',
        enabled:           true,
        health:            'degraded',
        owner:             'dispatcher',
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        fallbackMode:      'heartbeat',
        error:             `Agent config ${ agentId } does not exist.`,
      });
      return;
    }

    await LifecycleCapabilityModel.report({
      key:               'todo-execution',
      enabled:           true,
      health:            'healthy',
      owner:             'dispatcher',
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      fallbackMode:      'heartbeat',
    });

    let freeSlots = Math.max(0, concurrency - await WorkTaskDispatchModel.countRunning('execution'));
    while (freeSlots > 0 && this.initialized) {
      const claim = await WorkTaskDispatchModel.claimNext(agentId, RUNTIME_INSTANCE_ID);
      if (!claim) break;
      this.runClaim(claim).catch(err => console.error('[TaskDispatcher] Worker promise failed:', err));
      freeSlots -= 1;
    }
  }

  private async fillVerificationPool(): Promise<void> {
    const enabled = await SullaSettingsModel.get('taskVerifierEnabled', false);
    if (!enabled) {
      await LifecycleCapabilityModel.report({
        key:               'in-review-verification',
        enabled:           false,
        health:            'unavailable',
        owner:             null,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        fallbackMode:      'heartbeat',
      });
      return;
    }
    const owner = await this.resolveVerificationOwner();
    if (!owner) return;
    const configured = Number(await SullaSettingsModel.get('taskVerifierConcurrency', DEFAULT_CONCURRENCY));
    const concurrency = Math.max(1, Math.min(10, configured || DEFAULT_CONCURRENCY));
    const agentId = String(await SullaSettingsModel.get('taskVerifierAgentId', DEFAULT_VERIFIER_AGENT_ID)).trim() || DEFAULT_VERIFIER_AGENT_ID;
    if (!findAgentDir(agentId)) {
      console.error(`[TaskDispatcher] Agent config "${ agentId }" does not exist; verification paused`);
      await LifecycleCapabilityModel.report({
        key:               'in-review-verification',
        enabled:           true,
        health:            'degraded',
        owner:             'dispatcher',
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        fallbackMode:      'heartbeat',
        error:             `Agent config ${ agentId } does not exist.`,
      });
      return;
    }

    await LifecycleCapabilityModel.report({
      key:               'in-review-verification',
      enabled:           true,
      health:            'healthy',
      owner:             'dispatcher',
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      fallbackMode:      'heartbeat',
    });

    let freeSlots = Math.max(0, concurrency - await WorkTaskDispatchModel.countRunning('verification'));
    while (freeSlots > 0 && this.initialized) {
      const claim = await WorkTaskDispatchModel.claimNextReview(
        agentId,
        owner === 'core-routine' ? [...REVIEWER_AGENT_IDS] : [],
        RUNTIME_INSTANCE_ID,
      );
      if (!claim) break;
      this.runClaim(claim, owner).catch(err => console.error('[TaskDispatcher] Verifier promise failed:', err));
      freeSlots -= 1;
    }
  }

  /** One service and one claim path own in_review. Disabling the core routine pauses it. */
  private async resolveVerificationOwner(): Promise<VerificationOwner | null> {
    const configured = String(await SullaSettingsModel.get('taskVerifierOwner', 'legacy'));
    if (configured === 'legacy') return 'legacy';
    const rolloutEnabled = await SullaSettingsModel.get('taskReviewCoreRoutineEnabled', false);
    if (!rolloutEnabled) return null;
    const routine = await WorkflowModel.findById(REVIEW_PROJECT_ARTIFACT_ID);
    if (!routine || routine.attributesSnapshot.enabled === false) return null;
    return 'core-routine';
  }

  private async runClaim(claim: ClaimedDispatch, verificationOwner: VerificationOwner = 'legacy'): Promise<void> {
    const { dispatch, task, stage_claim: liveStageClaim } = claim;
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
      if (!isVerification) {
        await WorkItemsModel.addComment({
          task_id: task.id,
          author:  'dispatcher',
          body:    `Mechanical dispatch started with ${ dispatch.agent_id } (dispatch ${ dispatch.id }, attempt ${ dispatch.attempt || 1 }).`,
        }).catch(err => console.error(`[TaskDispatcher] Could not write start comment for ${ dispatch.id }:`, err));
      }

      const comments = isVerification ? await WorkItemsModel.listComments(task.id) : [];
      let claimedArtifacts: ReviewArtifactComponent[] = [];
      let excludedAgentIds: string[] = [];
      let selectedReviewerAgentIds: string[] = [];
      let generationHash = '';
      if (isVerification && verificationOwner === 'core-routine') {
        claimedArtifacts = await this.resolveReviewArtifacts(task, comments, dispatch.origin_evidence);
        const binding = await WorkTaskDispatchModel.bindReviewGeneration(dispatch.id, claimedArtifacts);
        if (binding.suppressed) return;
        excludedAgentIds = binding.excludedAgentIds;
        selectedReviewerAgentIds = REVIEWER_AGENT_IDS.filter(id => !excludedAgentIds.includes(id));
        if (selectedReviewerAgentIds.length === 0) {
          await WorkTaskDispatchModel.failVerification(dispatch.id, 'no_independent_reviewer_available');
          return;
        }
        generationHash = binding.generationHash;
      }

      const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(
        dispatch.agent_id,
        dispatch.thread_id,
        { isTrustedUser: 'trusted' },
      ) as { graph: any; state: any };

      if (isVerification) {
        const reviewPrompt = verificationOwner === 'core-routine'
          ? this.buildProtectedReviewPrompt(task, dispatch, comments, claimedArtifacts, generationHash, excludedAgentIds)
          : this.buildVerifierPrompt(task, dispatch.id, comments);
        state.messages.push({ role: 'user', content: reviewPrompt });
        const verifierTools = verificationOwner === 'core-routine' ? PROTECTED_REVIEW_TOOLS : [...LEGACY_VERIFIER_TOOLS];
        const llmTools = await Promise.all(verifierTools.map(name => toolRegistry.convertToolToLLM(name)));
        state.llmTools = llmTools;
        state.metadata.allowedToolNames = verifierTools;
        state.metadata.verifierReadOnly = true;
        if (verificationOwner === 'core-routine') {
          const definition = this.buildReviewDefinition(excludedAgentIds);
          const playbook = createPlaybookState(definition as any, reviewPrompt);
          state.metadata.activeWorkflow = playbook;
          state.metadata.verificationAdapters = ARTIFACT_VERIFICATION_ADAPTERS;
          await WorkTaskDispatchModel.recordReviewLaunch(dispatch.id, playbook.executionId, selectedReviewerAgentIds);
          try {
            const { WorkflowExecutionModel } = await import('../database/models/WorkflowExecutionModel');
            await WorkflowExecutionModel.markRunning({
              executionId:  playbook.executionId,
              workflowId:   REVIEW_PROJECT_ARTIFACT_ID,
              workflowName: REVIEW_PROJECT_ARTIFACT_DEFINITION.name,
              workflowSlug: REVIEW_PROJECT_ARTIFACT_ID,
              triggerInput: reviewPrompt,
            });
          } catch (err) {
            console.warn(`[TaskDispatcher] Could not record review workflow ${ playbook.executionId }:`, err);
          }
        }
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
        } else if (verificationOwner === 'core-routine') {
          const parsed = this.parseProtectedReview(finalState.metadata?.lastCompletedWorkflow);
          if (!parsed) {
            await WorkTaskDispatchModel.failVerification(dispatch.id, 'malformed_protected_review_output');
          } else {
            const currentArtifacts = await this.resolveReviewArtifacts(task, comments, dispatch.origin_evidence);
            const currentGenerationHash = WorkTaskDispatchModel.reviewGenerationHash(currentArtifacts);
            const parsedCode = parsed.artifacts.filter(artifact => artifact.code || artifact.type === 'code_pr');
            const currentCode = currentArtifacts.filter(artifact => artifact.code || artifact.type === 'code_pr');
            const codeHeadsMatch = parsedCode.length === currentCode.length && currentCode.every(current =>
              parsedCode.some(parsedArtifact => parsedArtifact.canonicalRef === current.canonicalRef && parsedArtifact.hash === current.hash),
            );
            if (currentCode.length > 0 && !codeHeadsMatch) {
              await WorkTaskDispatchModel.failVerification(dispatch.id, 'pull_request_artifact_unresolved');
            } else if (parsed.generationHash !== generationHash || currentGenerationHash !== generationHash) {
              await WorkTaskDispatchModel.failVerification(
                dispatch.id,
                `artifact_generation_changed:${ generationHash }:${ currentGenerationHash }`,
              );
            } else {
              const evidence: ProtectedReviewEvidence = {
                workflowExecutionId: finalState.metadata.lastCompletedWorkflow.executionId,
                reviewerAgentIds:    selectedReviewerAgentIds,
                excludedAgentIds,
                generationHash,
                artifactTypes:       parsed.artifactTypes,
                artifacts:           parsed.artifacts,
                artifactType:        parsed.artifactType,
                artifactRef:         parsed.artifactRef,
                artifactUrl:         parsed.artifactUrl,
                artifactHash:        parsed.artifactHash,
                summary:             parsed.summary,
                checks:              parsed.checks,
                findings:            parsed.findings,
                wait:                parsed.wait,
              };
              const settled = await WorkTaskDispatchModel.finalizeProtectedReview(
                dispatch.id,
                parsed.disposition,
                evidence,
                currentArtifacts,
              );
              if (!settled) {
                await WorkTaskDispatchModel.failVerification(dispatch.id, 'protected_review_settlement_rejected');
              }
            }
          }
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
      await LifecycleCapabilityModel.releaseStage(liveStageClaim.id)
        .catch(err => console.error(`[TaskDispatcher] Stage-claim release failed for ${ liveStageClaim.id }:`, err));
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
        verdict:     parsed.verdict,
        artifactSha: parsed.artifact_sha.toLowerCase(),
        summary:     parsed.summary.trim().slice(0, 8_000),
      };
    } catch {
      return null;
    }
  }

  private parseJsonObject(value: unknown): Record<string, any> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
    if (typeof value !== 'string') return null;
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(value.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private parseProtectedReview(completed: any): ParsedProtectedReview | null {
    if (completed?.outcome !== 'completed' || completed.workflowId !== REVIEW_PROJECT_ARTIFACT_ID) return null;
    const synthesis = completed.nodeResults?.find((node: any) => node.nodeId === 'node-review-synthesize');
    const parsed = this.parseJsonObject(synthesis?.result);
    if (!parsed || !['PASS', 'REPAIRABLE', 'REPLAN', 'EXTERNAL_WAIT', 'BLOCKED'].includes(parsed.disposition)) return null;
    if (typeof parsed.artifactType !== 'string' || !parsed.artifactType.trim()) return null;
    if (typeof parsed.generationHash !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.generationHash)) return null;
    const artifactTypes = Array.isArray(parsed.artifactTypes) ? parsed.artifactTypes : [];
    const allowedTypes = new Set(Object.keys(ARTIFACT_VERIFICATION_ADAPTERS));
    if (artifactTypes.length === 0 || artifactTypes.some((value: unknown) => typeof value !== 'string' || !allowedTypes.has(value))) return null;
    if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0) return null;
    const artifacts = parsed.artifacts.filter((artifact: any) => artifact && typeof artifact === 'object');
    if (artifacts.length !== parsed.artifacts.length || artifacts.some((artifact: any) =>
      !allowedTypes.has(artifact.type) || typeof artifact.canonicalRef !== 'string' ||
      typeof artifact.adapter !== 'string' || typeof artifact.code !== 'boolean' ||
      artifact.adapter !== ARTIFACT_VERIFICATION_ADAPTERS[artifact.type as ReviewArtifactType].adapter ||
      typeof artifact.hash !== 'string' || !/^[a-f0-9]{40,64}$/i.test(artifact.hash))) return null;
    if (typeof parsed.artifactRef !== 'string' || !parsed.artifactRef.trim()) return null;
    if (typeof parsed.artifactHash !== 'string' || !/^[a-f0-9]{40,64}$/i.test(parsed.artifactHash)) return null;
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
    if (!Array.isArray(parsed.checks) || !Array.isArray(parsed.findings)) return null;
    if (parsed.disposition === 'EXTERNAL_WAIT') {
      const wait = parsed.wait;
      if (!wait || !['github_checks', 'human_gate', 'scheduled_time', 'external_job'].includes(wait.kind)) return null;
      if (typeof wait.targetKey !== 'string' || !wait.targetKey.trim()) return null;
      if (!wait.target || typeof wait.target !== 'object' || Array.isArray(wait.target)) return null;
    }
    return {
      disposition:    parsed.disposition,
      generationHash: parsed.generationHash.toLowerCase(),
      artifactTypes:  artifactTypes as ReviewArtifactType[],
      artifacts:      artifacts.map((artifact: any) => ({
        type:         artifact.type,
        canonicalRef: artifact.canonicalRef.trim(),
        url:          typeof artifact.url === 'string' ? artifact.url.trim() : null,
        hash:         artifact.hash.toLowerCase(),
        adapter:      artifact.adapter.trim(),
        code:         artifact.code,
      })),
      artifactType: parsed.artifactType.trim(),
      artifactRef:  parsed.artifactRef.trim(),
      artifactUrl:  typeof parsed.artifactUrl === 'string' ? parsed.artifactUrl.trim() : null,
      artifactHash: parsed.artifactHash.toLowerCase(),
      summary:      parsed.summary.trim().slice(0, 8_000),
      checks:       parsed.checks,
      findings:     parsed.findings,
      wait:         parsed.wait ?? null,
    };
  }

  private buildReviewDefinition(excludedAgentIds: string[]): Record<string, any> {
    const definition = JSON.parse(JSON.stringify(REVIEW_PROJECT_ARTIFACT_DEFINITION));
    if (excludedAgentIds.length === 0) return definition;
    const excluded = new Set(
      definition.nodes
        .filter((node: any) => (REVIEWER_NODE_IDS as readonly string[]).includes(node.id) && excludedAgentIds.includes(node.data?.config?.agentId))
        .map((node: any) => node.id),
    );
    if (excluded.size === 0) return definition;
    definition.nodes = definition.nodes.filter((node: any) => !excluded.has(node.id));
    definition.edges = definition.edges.filter((edge: any) => !excluded.has(edge.source) && !excluded.has(edge.target));
    return definition;
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

    // Persist the worker's blocker/result before the status transition. A
    // blocked transition immediately snapshots the task for the planning
    // council, so racing the comment and update could omit the original
    // blocker from every planner's input.
    const settled = await Promise.allSettled([
      WorkTaskDispatchModel.settle(dispatch.id, status, result, error),
      WorkItemsModel.addComment({ task_id: task.id, author: 'dispatcher', body: comment }),
    ]);

    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        console.error(`[TaskDispatcher] Could not finalize ${ dispatch.id }:`, outcome.reason);
      }
    }

    try {
      await WorkItemsModel.updateTask(task.id, {
        status: taskStatus, assignee: 'heartbeat', actor: 'dispatcher',
      });
    } catch (err) {
      console.error(`[TaskDispatcher] Could not move task ${ task.id } after ${ dispatch.id }:`, err);
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

  private async resolveReviewArtifacts(task: WorkTaskRecord, comments: { body: string }[], originEvidence?: Record<string, unknown> | null): Promise<ReviewArtifactComponent[]> {
    const heads = await resolvePullRequestHeads(task.github_issue, comments);
    const code = heads.map(head => ({
      type:         'code_pr' as const,
      canonicalRef: `${ head.owner.toLowerCase() }/${ head.repo.toLowerCase() }#${ head.pullNumber }`,
      url:          `https://github.com/${ head.owner }/${ head.repo }/pull/${ head.pullNumber }`,
      hash:         head.sha.toLowerCase(),
      adapter:      'github-pr',
      code:         true,
    }));
    const custodyHash = WorkTaskDispatchModel.reviewFingerprint([{
      task:      { id: task.id, title: task.title, description: task.description, githubIssue: task.github_issue },
      execution: originEvidence ?? null,
    }]);
    return [...code, {
      type:         'projects_evidence',
      canonicalRef: `projects-task:${ task.id }`,
      hash:         custodyHash,
      adapter:      'projects-read',
      code:         false,
    }];
  }

  private buildProtectedReviewPrompt(task: WorkTaskRecord, dispatch: ClaimedDispatch['dispatch'], comments: { author: string | null; body: string }[], artifacts: ReviewArtifactComponent[], generationHash: string, excludedAgentIds: string[]): string {
    const history = comments.slice(-50).map(comment => ({
      author: comment.author || 'unknown',
      body:   comment.body.slice(0, 4_000),
    }));
    return `Protected in_review generation for Projects task ${ task.id }.

Title: ${ task.title }
Priority: ${ task.priority }
Project: ${ task.project_id }
Epic: ${ task.epic_id ?? '(none)' }
Review dispatch: ${ dispatch.id }
Originating execution ID: ${ dispatch.origin_dispatch_id ?? '(legacy execution; use comments)' }
Originating worker: ${ dispatch.origin_agent_id ?? '(unknown)' }
Originating execution ledger snapshot:
${ JSON.stringify(dispatch.origin_evidence ?? {}) }
Artifact hint: ${ task.github_issue ?? '(resolve from custody evidence)' }
Bound review generation: ${ generationHash }
Structured artifact components: ${ JSON.stringify(artifacts) }
Durably excluded worker/custodian identities: ${ JSON.stringify(excludedAgentIds) }
Read-only adapter catalog: ${ JSON.stringify(ARTIFACT_VERIFICATION_ADAPTERS) }

Acceptance contract:
${ task.description || '(no description)' }

Bounded task evidence, oldest to newest:
${ JSON.stringify(history) }

The dispatcher already owns the collision-safe lease. Inspect the canonical artifact and immutable generation directly. Worker summaries are leads, never proof. Do not mutate product files, source control, Projects, external systems, or shared infrastructure. The dispatcher alone records the verdict and transition.`;
  }
}
