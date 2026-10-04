import { AbortService } from './AbortService';
import { ArtifactCustodyPolicy } from './ArtifactCustodyPolicy';
import { buildReceipt, renderReceiptComment } from './ArtifactReceiptService';
import { resolvePullRequestHead, resolvePullRequestHeads } from './GitHubPullRequestHeadService';
import { GraphRegistry } from './GraphRegistry';
import { resolveWipLimits, evaluateClaim, type WipLimits, type RoleCounts, type BackpressureDecision } from './ProjectAutomationWipLimits';
import { RoutineConcurrencyPolicy } from './RoutineConcurrencyPolicy';
import { postgresClient } from '../database/PostgresClient';
import { DispatcherLivenessModel, type DispatcherTickOutcome } from '../database/models/DispatcherLivenessModel';
import { LifecycleCapabilityModel } from '../database/models/LifecycleCapabilityModel';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import {
  WorkTaskDispatchModel,
  type ClaimedDispatch,
  type DispatchCandidate,
  type ProtectedReviewEvidence,
  type ReviewArtifactComponent,
  type ReviewArtifactType,
  type ReviewDisposition,
  type VerificationVerdict,
} from '../database/models/WorkTaskDispatchModel';
import { WorkflowModel } from '../database/models/WorkflowModel';
import { WorkflowExecutionModel } from '../database/models/WorkflowExecutionModel';
import { DEFAULT_CORE_ROUTINE_AGENT_ID } from '../routines/core/defaultCoreAgent';
import {
  REVIEW_PROJECT_ARTIFACT_DEFINITION,
  REVIEW_PROJECT_ARTIFACT_ID,
  ARTIFACT_VERIFICATION_ADAPTERS,
} from '../routines/core/reviewProjectArtifact';
import { extractAgentTurnOutcome } from '../tools/agents/agentTurnOutcome';
import { FULL_AGENT_TOOL_NAMES } from '../tools/fullAgentTools';
import { toolRegistry } from '../tools/registry';
import { createPlaybookState } from '../workflow/WorkflowPlaybook';

const CHECK_INTERVAL_MS = 60_000;
const LEASE_HEARTBEAT_MS = 120_000;
const DEFAULT_CONCURRENCY = 3;
const RUNTIME_INSTANCE_ID = `task-dispatcher-${ process.pid }-${ Date.now() }`;
const DEFAULT_VERIFIER_TIMEOUT_MINUTES = 45;
const DEFAULT_EXECUTION_TIMEOUT_MINUTES = 90;
const DEFAULT_TICK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TICK_QUERY_TIMEOUT_MS = 30_000;
const LEGACY_VERIFIER_TOOLS = [
  'file_search', 'read_file',
  'git_status', 'git_diff', 'git_log', 'git_blame',
  'github_get_issue', 'github_get_pr', 'github_get_pr_files', 'github_check_runs',
] as const;
/**
 * Workers and reviewers get exactly the full agent tool set the primary chat
 * gets (pinned so they never depend on the global dynamic tool mode). `exec`
 * reaches the whole Sulla catalog. No lane is restricted.
 */
const MECHANICAL_WORKER_TOOLS = FULL_AGENT_TOOL_NAMES;
/**
 * Agents get every comment in full. Only a runaway history beyond this many
 * characters drops its OLDEST comments from the prompt (never truncates a
 * body), and the prompt says how to read the rest.
 */
const HISTORY_PROMPT_BUDGET_CHARS = 200_000;

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

interface ProtectedReviewParseResult {
  value:  ParsedProtectedReview | null;
  // Short machine-readable cause of a null value, so repeat malformed-output
  // failures on a task carry an actionable reason instead of one opaque string.
  reason: string | null;
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
  private tickGeneration = 0;
  private activeTickGeneration: number | null = null;
  private activeTickStartedAt: string | null = null;
  private tickWedgeCount = 0;
  private lastTickError: string | null = null;
  private schedulerId: ReturnType<typeof setInterval> | null = null;
  private reclaimedReviews = 0;
  private active = new Map<string, AbortService>();
  private lastBackpressure: {
    limits:   WipLimits;
    counts:   RoleCounts;
    decision: BackpressureDecision;
    at:       string;
  } | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Arm the scheduler before any recovery or first tick can fail. The
    // initialized flag is truthful only after the scheduler exists, so a
    // failed first pass can recover on the next interval instead of bricking
    // the service behind a one-shot initialization gate.
    this.schedulerId = setInterval(() => {
      this.checkAndDispatch().catch(err => console.error('[TaskDispatcher] Scheduled check failed:', err));
    }, CHECK_INTERVAL_MS);
    this.initialized = true;
    await this.checkAndDispatch();
    console.log('[TaskDispatcher] Mechanical dispatcher initialized');
  }

  /** Immediate, idempotent nudge from a committed execution/review lane entry.
   * When taskId is supplied, return proof that the dispatcher owns that task;
   * a successful tick alone is not admission evidence because it may claim a
   * different task or find the queue backpressured. */
  async requestDispatch(taskId?: string): Promise<boolean> {
    if (!this.initialized) return false;
    await this.checkAndDispatch();
    if (!taskId) return true;
    return WorkTaskDispatchModel.hasActiveDispatchForTask(taskId);
  }

  async forceCheck(): Promise<void> {
    await this.checkAndDispatch();
  }

  /**
   * Current WIP limits, per-role counts, and the most recent backpressure
   * decision, so the Projects UI can explain why upstream work is held
   * (issue #711 AC6). Null until the first dispatch tick evaluates capacity.
   */
  getBackpressureStatus(): {
    limits:   WipLimits;
    counts:   RoleCounts;
    decision: BackpressureDecision;
    at:       string;
  } | null {
    return this.lastBackpressure;
  }

  destroy(): void {
    this.initialized = false;
    this.activeTickGeneration = null;
    this.activeTickStartedAt = null;
    if (this.schedulerId) {
      clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
    for (const abort of this.active.values()) abort.abort();
    this.active.clear();
  }

  private async checkAndDispatch(): Promise<void> {
    if (!this.initialized || this.activeTickGeneration !== null) return;
    const generation = ++this.tickGeneration;
    this.activeTickGeneration = generation;
    this.activeTickStartedAt = new Date().toISOString();
    this.lastTickError = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let tickTimeoutMs = DEFAULT_TICK_TIMEOUT_MS;
    let healthError: string | null = null;
    let outcome: DispatcherTickOutcome = 'idle';
    await DispatcherLivenessModel.beginTick(CHECK_INTERVAL_MS).catch(err =>
      console.error('[TaskDispatcher] Failed to record tick start:', err));
    try {
      // Read the setting inside the guarded section too: a stalled settings
      // read is itself a tick-path failure and must release the gate.
      tickTimeoutMs = await this.getTickTimeoutMs();
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error(`dispatcher tick ${ generation } exceeded ${ tickTimeoutMs }ms deadline`)), tickTimeoutMs);
      });
      outcome = await Promise.race([this.runTick(generation), timeout]);
    } catch (err) {
      outcome = 'error';
      const timedOut = err instanceof Error && err.message.includes('exceeded') && err.message.includes('deadline');
      healthError = timedOut ? 'tick deadline exceeded' : err instanceof Error ? err.message : String(err);
      this.lastTickError = healthError;
      if (timedOut) {
        this.tickWedgeCount += 1;
        console.error('[TaskDispatcher] Tick watchdog expired; releasing tick gate', {
          generation, startedAt: this.activeTickStartedAt, tickTimeoutMs, wedgeCount: this.tickWedgeCount,
        });
      } else {
        console.error('[TaskDispatcher] Dispatch check failed:', err);
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // An expired tick's promise may eventually settle. It must never clear
      // the gate belonging to a newer generation.
      if (this.activeTickGeneration === generation) {
        this.activeTickGeneration = null;
        this.activeTickStartedAt = null;
      }
      await DispatcherLivenessModel.completeTick(CHECK_INTERVAL_MS, outcome).catch(err =>
        console.error('[TaskDispatcher] Failed to record tick completion:', err));
    }
    // Capability reporting is also database-backed. Release the tick gate
    // before awaiting it so a wedged report cannot disable future ticks.
    if (healthError) {
      await this.reportTickHealth('degraded', healthError)
        .catch(reportErr => console.error('[TaskDispatcher] Tick health report failed:', reportErr));
    }
  }

  private async getTickTimeoutMs(): Promise<number> {
    const configured = Number(await Promise.race([
      SullaSettingsModel.get('taskDispatcherTickTimeoutMs', DEFAULT_TICK_TIMEOUT_MS),
      new Promise(resolve => setTimeout(() => resolve(DEFAULT_TICK_TIMEOUT_MS), 1000)),
    ]));
    return Math.max(1000, configured || DEFAULT_TICK_TIMEOUT_MS);
  }

  private async runTick(generation: number): Promise<DispatcherTickOutcome> {
    return postgresClient.withStatementTimeout(
      DEFAULT_TICK_QUERY_TIMEOUT_MS,
      () => this.runTickWithStatementTimeout(generation),
    );
  }

  private async runTickWithStatementTimeout(generation: number): Promise<DispatcherTickOutcome> {
    let outcome: DispatcherTickOutcome = 'idle';
    try {
      const reconciledWorkflowExecutions = await WorkflowExecutionModel.reconcileDispatcherOwnedExecutions();
      if (reconciledWorkflowExecutions.length > 0) {
        console.warn(`[TaskDispatcher] Reconciled ${ reconciledWorkflowExecutions.length } orphaned dispatcher workflow execution(s)`);
      }
      await LifecycleCapabilityModel.recoverPreviousRuntime('todo-execution', RUNTIME_INSTANCE_ID);
      const recoveredReviewClaims = await LifecycleCapabilityModel.recoverPreviousRuntime(
        'in-review-verification', RUNTIME_INSTANCE_ID,
      );
      this.reclaimedReviews += (await WorkTaskDispatchModel.recoverOrphanedVerification(
        recoveredReviewClaims,
      )).length;

      // The dispatcher is an independent system from the conversational Heartbeat
      // agent (Jonathon, 2026-08-25) -- it must not read heartbeatEnabled/heartbeatWindow.
      // Its own master switch is automatedProjectManagementEnabled (RoutineConcurrencyPolicy),
      // exposed as "Enable Automation PM Work" on the Project Automation settings tab.
      const enabled = await RoutineConcurrencyPolicy.isEnabled();
      if (!enabled) {
        outcome = 'disabled';
        await LifecycleCapabilityModel.report({
          key:               'todo-execution',
          enabled:           false,
          health:            'unavailable',
          owner:             null,
          runtimeInstanceId: RUNTIME_INSTANCE_ID,
          fallbackMode:      'manual_hold',
          error:             'Automated Project Management is disabled by user setting.',
        });
        return outcome;
      }

      // Run on every tick, not just once at boot. recoverStale() only
      // reclaims dispatches silent past its 45-minute heartbeat threshold,
      // so it's safe to call continuously -- and it must be, since a
      // dispatch can go dead mid-process-lifetime (a stuck sub-agent call,
      // a crashed worker) just as easily as it can from a prior restart.
      // A one-shot startup-only reclaim leaves those permanently stuck for
      // the rest of the process's uptime with nothing else watching them.
      const journaled = await WorkTaskDispatchModel.recoverPendingOutcomeJournals();
      if (journaled.length > 0) console.log(`[TaskDispatcher] Settled ${ journaled.length } journaled outcome(s)`);
      const recovered = await WorkTaskDispatchModel.recoverStale();
      if (recovered.length > 0) console.warn(`[TaskDispatcher] Recovered ${ recovered.length } stale dispatch(es)`);

      // Enumerate the whole portfolio before lane-specific claims. This is the
      // reasoning surface: paused projects, dependencies, waits, assignees and
      // custom lanes remain visible instead of disappearing behind SQL policy.
      // Claim methods still enforce collision locks and the explicit project
      // pause at mutation time.
      const considered = await WorkTaskDispatchModel.enumerateCandidates();
      console.log('[TaskDispatcher] Broad candidate consideration', {
        count: considered.length,
        newest: considered.slice(0, 10).map(candidate => ({
          id: candidate.id, lane: candidate.status, at: candidate.consideration_at,
          paused: !candidate.project_dispatch_enabled,
          wait: candidate.has_active_wait,
          dependencies: Number(candidate.unresolved_dependencies || 0),
          collision: candidate.has_active_dispatch || candidate.has_active_stage_claim,
        })),
      });

      // Preserve WIP telemetry, but do not turn portfolio context into an
      // admission deny-list. The hard execution bound is the configured worker
      // concurrency (three by default) plus collision-safe leases.
      try {
        const wipLimits = await resolveWipLimits();
        const roleCounts = await WorkTaskDispatchModel.countByRole();
        const wipDecision = evaluateClaim('execution', roleCounts, wipLimits);
        this.lastBackpressure = {
          limits:   wipLimits,
          counts:   roleCounts,
          decision: wipDecision,
          at:       new Date().toISOString(),
        };
      } catch (wipErr) {
        console.warn('[TaskDispatcher] WIP telemetry unavailable; lease concurrency remains enforced:', wipErr);
      }
      const dispatched = await this.fillCandidatePool(considered);
      outcome = dispatched > 0 ? 'actively-dispatching' : 'no-eligible-work';
      if (this.activeTickGeneration === generation) {
        await this.reportTickHealth('healthy');
      }
      return outcome;
    } catch (err) {
      // A timed-out generation can settle after a newer tick has started. It
      // must not overwrite the newer generation's diagnostics or health.
      if (this.activeTickGeneration !== generation) return 'error';
      this.lastTickError = err instanceof Error ? err.message : String(err);
      outcome = 'error';
      console.error('[TaskDispatcher] Dispatch check failed:', err);
      await LifecycleCapabilityModel.report({
        key:               'todo-execution',
        enabled:           true,
        health:            'degraded',
        owner:             'dispatcher',
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        fallbackMode:      'heartbeat',
        error:             this.lastTickError,
      }).catch(reportErr => console.error('[TaskDispatcher] Capability report failed:', reportErr));
      return outcome;
    }
  }

  private async reportTickHealth(health: 'healthy' | 'degraded', error?: string): Promise<void> {
    await LifecycleCapabilityModel.report({
      key:               'todo-execution',
      enabled:           this.initialized,
      health,
      owner:             this.initialized ? 'dispatcher' : null,
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      fallbackMode:      'heartbeat',
      error,
      details: {
        tickGeneration: this.tickGeneration,
        activeTickGeneration: this.activeTickGeneration,
        activeTickStartedAt: this.activeTickStartedAt,
        tickWedgeCount: this.tickWedgeCount,
        lastTickError: this.lastTickError,
      },
    });
  }

  private async fillCandidatePool(candidates: DispatchCandidate[]): Promise<number> {
    let dispatched = 0;
    const configured = Number(await SullaSettingsModel.get('taskDispatcherConcurrency', DEFAULT_CONCURRENCY));
    const capacity = Math.min(DEFAULT_CONCURRENCY, Math.max(1, configured || DEFAULT_CONCURRENCY));
    for (const candidate of candidates) {
      // Consider every row, even when an explicit stop or live editor prevents action.
      const hold = !candidate.project_dispatch_enabled ? 'project explicitly paused'
        : ['done', 'cancelled', 'parked'].includes(candidate.status) ? 'terminal task'
          : candidate.has_active_dispatch || candidate.has_active_stage_claim ? 'live owner' : null;
      if (hold) {
        console.log('[TaskDispatcher] Candidate held at action boundary', { taskId: candidate.id, hold });
        continue;
      }
      if (await WorkTaskDispatchModel.countRunning() >= capacity) continue;
      try {
        if (candidate.status === 'in_review') {
          if (await this.fillVerificationPool(candidate.id)) dispatched += 1;
        } else {
          dispatched += await this.fillExecutionPool(candidate.id);
        }
      } catch (error) {
        console.error('[TaskDispatcher] Candidate admission failed; considering remaining work', { taskId: candidate.id, error });
      }
    }
    return dispatched;
  }

  private async fillExecutionPool(taskId?: string): Promise<number> {
    const configured = Number(await SullaSettingsModel.get('taskDispatcherConcurrency', DEFAULT_CONCURRENCY));
    const concurrency = await RoutineConcurrencyPolicy.resolveLimit('execution', configured || DEFAULT_CONCURRENCY);
    const enforceSlots = await RoutineConcurrencyPolicy.isEnabled();
    if (enforceSlots) await RoutineConcurrencyPolicy.reclaimStale();
    const agentId = DEFAULT_CORE_ROUTINE_AGENT_ID;

    await LifecycleCapabilityModel.report({
      key:               'todo-execution',
      enabled:           true,
      health:            'healthy',
      owner:             'dispatcher',
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      fallbackMode:      'manual_hold',
    });

    let freeSlots = Math.min(taskId ? 1 : concurrency, Math.max(0, concurrency - await WorkTaskDispatchModel.countRunning('execution')));
    let dispatched = 0;
    while (freeSlots > 0 && this.initialized) {
      let slot: string | null = null;
      if (enforceSlots) {
        slot = await RoutineConcurrencyPolicy.acquire('execution', concurrency, { owner: RUNTIME_INSTANCE_ID });
        if (!slot) break;
      }
      const claim = await WorkTaskDispatchModel.claimNext(agentId, RUNTIME_INSTANCE_ID, undefined, taskId)
        .catch(async(error) => {
          if (slot) await RoutineConcurrencyPolicy.release(slot);
          throw error;
        });
      if (!claim) {
        if (slot) await RoutineConcurrencyPolicy.release(slot);
        break;
      }
      const heldSlot = slot;
      const slotHeartbeat = heldSlot ? setInterval(() => { if (heldSlot) void RoutineConcurrencyPolicy.heartbeat(heldSlot); }, 30000) : null;
      this.runClaim(claim)
        .catch(err => console.error('[TaskDispatcher] Worker promise failed:', err))
        .finally(() => {
          if (slotHeartbeat) clearInterval(slotHeartbeat);
          if (heldSlot) void RoutineConcurrencyPolicy.release(heldSlot);
        });
      freeSlots -= 1;
      dispatched += 1;
    }
    return dispatched;
  }

  private async fillVerificationPool(taskId?: string): Promise<boolean> {
    const enabled = await SullaSettingsModel.get('taskVerifierEnabled', true);
    if (!enabled) {
      await LifecycleCapabilityModel.report({
        key:               'in-review-verification',
        enabled:           false,
        health:            'unavailable',
        owner:             null,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        fallbackMode:      'manual_hold',
        details:           { ...(await WorkTaskDispatchModel.verificationPoolStats()), reclaimed: this.reclaimedReviews },
      });
      return false;
    }
    const owner = await this.resolveVerificationOwner();
    if (!owner) {
      await LifecycleCapabilityModel.report({
        key:               'in-review-verification',
        enabled:           true,
        health:            'unavailable',
        owner:             null,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        fallbackMode:      'manual_hold',
        error:             'Protected review routine, rollout, or default agent is unavailable.',
        details:           { ...(await WorkTaskDispatchModel.verificationPoolStats()), reclaimed: this.reclaimedReviews },
      });
      return false;
    }
    const configured = Number(await SullaSettingsModel.get('taskVerifierConcurrency', DEFAULT_CONCURRENCY));
    const concurrency = await RoutineConcurrencyPolicy.resolveLimit('review', configured || DEFAULT_CONCURRENCY);
    const enforceSlots = await RoutineConcurrencyPolicy.isEnabled();
    if (enforceSlots) await RoutineConcurrencyPolicy.reclaimStale();
    const agentId = DEFAULT_CORE_ROUTINE_AGENT_ID;

    await LifecycleCapabilityModel.report({
      key:               'in-review-verification',
      enabled:           true,
      health:            'healthy',
      owner:             'dispatcher',
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      fallbackMode:      'heartbeat',
      details:           { ...(await WorkTaskDispatchModel.verificationPoolStats()), reclaimed: this.reclaimedReviews },
    });

    let freeSlots = Math.min(taskId ? 1 : concurrency, Math.max(0, concurrency - await WorkTaskDispatchModel.countRunning('verification')));
    let dispatched = false;
    while (freeSlots > 0 && this.initialized) {
      let slot: string | null = null;
      if (enforceSlots) {
        slot = await RoutineConcurrencyPolicy.acquire('review', concurrency, { owner: RUNTIME_INSTANCE_ID });
        if (!slot) break;
      }
      const claim = await WorkTaskDispatchModel.claimNextReview(
        agentId,
        owner === 'core-routine' ? [DEFAULT_CORE_ROUTINE_AGENT_ID] : [],
        RUNTIME_INSTANCE_ID,
        taskId,
      ).catch(async(error) => {
        if (slot) await RoutineConcurrencyPolicy.release(slot);
        throw error;
      });
      if (!claim) {
        if (slot) await RoutineConcurrencyPolicy.release(slot);
        break;
      }
      const heldSlot = slot;
      const slotHeartbeat = heldSlot ? setInterval(() => { if (heldSlot) void RoutineConcurrencyPolicy.heartbeat(heldSlot); }, 30000) : null;
      this.runClaim(claim, owner)
        .catch(err => console.error('[TaskDispatcher] Verifier promise failed:', err))
        .finally(() => {
          if (slotHeartbeat) clearInterval(slotHeartbeat);
          if (heldSlot) void RoutineConcurrencyPolicy.release(heldSlot);
        });
      freeSlots -= 1;
      dispatched = true;
    }
    await LifecycleCapabilityModel.report({
      key:               'in-review-verification',
      enabled:           true,
      health:            'healthy',
      owner:             'dispatcher',
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      fallbackMode:      'manual_hold',
      details:           { ...(await WorkTaskDispatchModel.verificationPoolStats()), reclaimed: this.reclaimedReviews },
    });
    return dispatched;
  }

  /**
   * One service and one claim path own in_review. Disabling the core routine
   * pauses it. The default core routine agent (DEFAULT_CORE_ROUTINE_AGENT_ID)
   * is never required to have an on-disk profile directory -- it is the
   * product default, and every other agent-resolution path (BaseNode,
   * GraphRegistry) already falls back to built-in defaults when no directory
   * exists. Gating availability on filesystem presence here made a missing/
   * deleted override folder take down the entire review pipeline.
   */
  private async resolveVerificationOwner(): Promise<VerificationOwner | null> {
    const configured = String(await SullaSettingsModel.get('taskVerifierOwner', 'core-routine'));
    if (configured === 'legacy') return 'legacy';
    if (configured !== 'core-routine') return null;
    const rolloutEnabled = await SullaSettingsModel.get('taskReviewCoreRoutineEnabled', true);
    if (!rolloutEnabled) return null;
    const routine = await WorkflowModel.findById(REVIEW_PROJECT_ARTIFACT_ID);
    if (!routine || routine.attributesSnapshot.enabled === false) return null;
    return 'core-routine';
  }

  private async runClaim(claim: ClaimedDispatch, verificationOwner: VerificationOwner = 'legacy'): Promise<void> {
    const { dispatch, task, stage_claim: liveStageClaim } = claim;
    const abort = new AbortService();
    this.active.set(dispatch.id, abort);
    let lastActivityAt = Date.now();
    let leaseTimer: ReturnType<typeof setInterval> | null = null;
    let runTimeout: ReturnType<typeof setTimeout> | null = null;
    let expireRun: (() => void) | null = null;
    let verifierTimedOut = false;
    let executionTimedOut = false;

    try {
      const isVerification = dispatch.kind === 'verification';
      if (!isVerification) {
        await WorkItemsModel.addComment({
          task_id: task.id,
          author:  'dispatcher',
          body:    `Mechanical dispatch started with ${ dispatch.agent_id } (dispatch ${ dispatch.id }, attempt ${ dispatch.attempt || 1 }).`,
        }).catch(err => console.error(`[TaskDispatcher] Could not write start comment for ${ dispatch.id }:`, err));
      }

      const comments = await WorkItemsModel.listComments(task.id);
      const planContext = await this.loadPlanContext(task);
      let claimedArtifacts: ReviewArtifactComponent[] = [];
      let excludedAgentIds: string[] = [];
      let selectedReviewerAgentIds: string[] = [];
      let generationHash = '';
      if (isVerification && verificationOwner === 'core-routine') {
        claimedArtifacts = await this.resolveReviewArtifacts(task, comments, dispatch.origin_evidence);
        const binding = await WorkTaskDispatchModel.bindReviewGeneration(dispatch.id, claimedArtifacts);
        if (binding.suppressed) return;
        excludedAgentIds = binding.excludedAgentIds;
        // Review independence comes from separate workflow-node executions and
        // threads. Agent profile identity is deliberately the same default
        // Sulla Desktop profile for workers, reviewers, and synthesizers.
        selectedReviewerAgentIds = [DEFAULT_CORE_ROUTINE_AGENT_ID];
        generationHash = binding.generationHash;
      }

      const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(
        dispatch.agent_id,
        dispatch.thread_id,
        { isTrustedUser: 'trusted' },
      ) as { graph: any; state: any };
      state.metadata.lastAgentActivityAt = Date.now();
      lastActivityAt = Number(state.metadata.lastAgentActivityAt);
      leaseTimer = setInterval(
        () => {
          const activityAt = Number(state.metadata.lastAgentActivityAt ?? 0);
          if (activityAt <= lastActivityAt) return;
          lastActivityAt = activityAt;
          WorkTaskDispatchModel.touch(dispatch.id)
            .catch(err => console.error(`[TaskDispatcher] Lease refresh failed for ${ dispatch.id }:`, err));
        },
        LEASE_HEARTBEAT_MS,
      );

      if (isVerification) {
        const reviewPrompt = verificationOwner === 'core-routine'
          ? this.buildProtectedReviewPrompt(task, dispatch, comments, claimedArtifacts, generationHash, excludedAgentIds, planContext)
          : this.buildVerifierPrompt(task, dispatch.id, comments);
        state.messages.push({ role: 'user', content: reviewPrompt });
        // Reviewers get the same full authority as workers (exec = the whole
        // Sulla catalog, no read-only sandbox), plus the adapter tools the
        // review routine names explicitly.
        const verifierTools = [...new Set([
          ...MECHANICAL_WORKER_TOOLS,
          ...(verificationOwner === 'core-routine' ? PROTECTED_REVIEW_TOOLS : LEGACY_VERIFIER_TOOLS),
        ])];
        const llmTools = await Promise.all(verifierTools.map(name => toolRegistry.convertToolToLLM(name)));
        state.llmTools = llmTools;
        state.metadata.allowedToolNames = verifierTools;
        if (verificationOwner === 'core-routine') {
          const playbook = createPlaybookState(REVIEW_PROJECT_ARTIFACT_DEFINITION as any, reviewPrompt);
          state.metadata.activeWorkflow = playbook;
          state.metadata.verificationAdapters = ARTIFACT_VERIFICATION_ADAPTERS;
          await WorkTaskDispatchModel.recordReviewLaunchWithExecution(dispatch.id, {
            executionId: playbook.executionId,
            workflowId: REVIEW_PROJECT_ARTIFACT_ID,
            workflowName: REVIEW_PROJECT_ARTIFACT_DEFINITION.name,
            workflowSlug: REVIEW_PROJECT_ARTIFACT_ID,
            triggerInput: reviewPrompt,
            scopeTaskId: task.id,
            reviewerAgentIds: selectedReviewerAgentIds,
          });
        }
      } else {
        // A mechanical worker is an unattended coding/operations actor. Do
        // not leave its tool surface to the global toolMode or an optional
        // filesystem profile: either can resolve to meta-only tools and make
        // the worker silently stall before it can inspect or change code.
        const workerTools = [...MECHANICAL_WORKER_TOOLS];
        state.llmTools = await Promise.all(
          workerTools.map(name => toolRegistry.convertToolToLLM(name)),
        );
        state.metadata.allowedToolNames = workerTools;
        state.messages.push({ role: 'user', content: this.buildWorkerPrompt(task, dispatch.id, dispatch.agent_id, comments, planContext) });
      }
      state.metadata.isSubAgent = true;
      // Dispatched workers and verifiers do real work; they must chat through
      // the primary model chain, not the subconscious observer slot.
      state.metadata.modelSlot = 'primary';
      state.metadata.subAgentDepth = 1;
      state.metadata.workflowParentChannel = 'task-dispatcher';
      state.metadata.options ??= {};
      state.metadata.options.abort = abort;

      const timeoutMinutes = isVerification
        ? Math.max(1, Number(await SullaSettingsModel.get('taskVerifierTimeoutMinutes', DEFAULT_VERIFIER_TIMEOUT_MINUTES)) || DEFAULT_VERIFIER_TIMEOUT_MINUTES)
        : Math.max(0.001, Number(await SullaSettingsModel.get('taskDispatcherExecutionTimeoutMinutes', DEFAULT_EXECUTION_TIMEOUT_MINUTES)) || DEFAULT_EXECUTION_TIMEOUT_MINUTES);
      const timeoutEnabledSetting = isVerification
        ? true
        : await SullaSettingsModel.get('taskDispatcherExecutionTimeoutEnabled', true);
      const timeoutEnabled = timeoutEnabledSetting === true || timeoutEnabledSetting === 'true';
      const reportOnlySetting = isVerification
        ? false
        : await SullaSettingsModel.get('taskDispatcherExecutionTimeoutReportOnly', false);
      const reportOnly = reportOnlySetting === true || reportOnlySetting === 'true';
      const runtimeDeadline = new Promise<null>((resolve) => {
        expireRun = () => resolve(null);
      });
      runTimeout = setTimeout(() => {
        if (!timeoutEnabled || reportOnly) {
          console.warn(`[TaskDispatcher] Execution timeout report-only for ${ dispatch.id } after ${ timeoutMinutes } minute(s)`);
          return;
        }
        if (isVerification) verifierTimedOut = true;
        else executionTimedOut = true;
        abort.abort();
        expireRun?.();
        if (!isVerification) {
          WorkTaskDispatchModel.settle(
            dispatch.id,
            'timed_out',
            undefined,
            `execution exceeded ${ timeoutMinutes } minute(s)`,
          ).catch(err => console.error(`[TaskDispatcher] Timeout settlement failed for ${ dispatch.id }:`, err));
        }
      }, timeoutMinutes * 60_000);
      let finalState = await Promise.race([graph.execute(state), runtimeDeadline]);

      // An abort signal is cooperative; an immortal provider promise may
      // ignore it forever. The deadline itself therefore wins the race and
      // unwinds runClaim so its finally block releases the stage and WIP slot.
      if (!finalState) {
        if (isVerification && verifierTimedOut) {
          await WorkTaskDispatchModel.failVerification(dispatch.id, 'verifier_timeout');
        }
        return;
      }

      // Single-agent workflow nodes (e.g. node-review-classify) are
      // dispatched fire-and-forget inside Graph.execute() so interactive
      // callers (live chat, PlanningCouncilService) can stay responsive
      // while a background sub-agent call runs and reconnects later via
      // PlaybookController.triggerPlaybookContinuation. This dispatcher
      // call has nothing else to do until the review workflow actually
      // finishes, so wait here for the SAME in-process completion instead
      // of treating graph.execute()'s premature return as terminal --
      // otherwise the finally block below deletes the GraphRegistry entry
      // the background completion needs to reconnect into, and the
      // workflow orphans (kTJ1: malformed_protected_review_output).
      if (isVerification && verificationOwner === 'core-routine' && !finalState.metadata?.lastCompletedWorkflow) {
        const executionId = state.metadata?.activeWorkflow?.executionId;
        if (executionId) {
          await this.awaitReviewWorkflowSettlement(executionId, () => verifierTimedOut);
        }
      }

      if (executionTimedOut) return;

      let outcome = extractAgentTurnOutcome(finalState);
      if (!isVerification && outcome.status === 'completed' && !/<WORK_RESULT>[\s\S]*?<\/WORK_RESULT>/.test(outcome.text)) {
        state.messages.push({
          role:    'user',
          content: `Your last turn ended without the required <WORK_RESULT> block. Report the current state now and end with exactly one complete <WORK_RESULT>{\"summary\":\"...\"}</WORK_RESULT> block. If a background check or CI is still running, report it as pending in the summary; do not wait for it.`,
        });
        finalState = await Promise.race([graph.execute(state), runtimeDeadline]);
        if (!finalState) return;
        outcome = extractAgentTurnOutcome(finalState);
      }
      const summary = outcome.text.slice(0, 8_000);

      if (isVerification) {
        if (verifierTimedOut) {
          await WorkTaskDispatchModel.failVerification(dispatch.id, 'verifier_timeout');
        } else if (verificationOwner === 'core-routine') {
          const { value: parsed, reason: parseFailureReason } = this.parseProtectedReview(finalState.metadata?.lastCompletedWorkflow);
          if (!parsed) {
            // A missing disposition can mean the synthesis node correctly abstained on a generation superseded mid-flight, not a malformed output.
            const liveTask = await WorkItemsModel.getTask(task.id);
            if (liveTask?.status !== 'in_review') {
              const currentArtifacts = await this.resolveReviewArtifacts(task, comments, dispatch.origin_evidence);
              const currentGenerationHash = WorkTaskDispatchModel.reviewGenerationHash(currentArtifacts);
              await WorkTaskDispatchModel.failVerification(
                dispatch.id,
                `artifact_generation_changed:${ generationHash }:${ currentGenerationHash }`,
              );
            } else {
              await WorkTaskDispatchModel.failVerification(dispatch.id, `malformed_protected_review_output:${ parseFailureReason }`);
            }
          } else {
            const currentArtifacts = await this.resolveReviewArtifacts(task, comments, dispatch.origin_evidence);
            const currentGenerationHash = WorkTaskDispatchModel.reviewGenerationHash(currentArtifacts);
            const parsedCode = parsed.artifacts.filter(artifact => artifact.code || artifact.type === 'code_pr');
            const currentCode = currentArtifacts.filter(artifact => artifact.code || artifact.type === 'code_pr');
            const codeHeadsMatch = parsedCode.length === currentCode.length && currentCode.every(current =>
              parsedCode.some(parsedArtifact => parsedArtifact.canonicalRef === current.canonicalRef && parsedArtifact.hash === current.hash),
            );
            const advancedByInLaneRepair = parsed.disposition === 'REPAIRABLE' &&
              parsed.generationHash === currentGenerationHash && currentGenerationHash !== generationHash;
            if (currentCode.length > 0 && !codeHeadsMatch) {
              await WorkTaskDispatchModel.failVerification(dispatch.id, 'pull_request_artifact_unresolved');
            } else if (!advancedByInLaneRepair &&
              (parsed.generationHash !== generationHash || currentGenerationHash !== generationHash)) {
              await WorkTaskDispatchModel.failVerification(
                dispatch.id,
                `artifact_generation_changed:${ generationHash }:${ currentGenerationHash }`,
              );
            } else {
              const evidence: ProtectedReviewEvidence = {
                workflowExecutionId: finalState.metadata.lastCompletedWorkflow.executionId,
                reviewerAgentIds:    selectedReviewerAgentIds,
                excludedAgentIds,
                generationHash:      parsed.generationHash,
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
      if (runTimeout) clearTimeout(runTimeout);
      if (leaseTimer) clearInterval(leaseTimer);
      await LifecycleCapabilityModel.releaseStage(liveStageClaim.id)
        .catch(err => console.error(`[TaskDispatcher] Stage-claim release failed for ${ liveStageClaim.id }:`, err));
      this.active.delete(dispatch.id);
      GraphRegistry.delete(dispatch.thread_id);
      if (this.initialized) {
        this.checkAndDispatch().catch(err => console.error('[TaskDispatcher] Refill check failed:', err));
      }
    }
  }

  /**
   * Poll the durable execution record for a dispatcher-driven review
   * workflow until PlaybookController.releaseWorkflow() has settled it
   * (WorkflowExecutionModel.settle), or the verifier timeout fires. This
   * intentionally does not introduce a new drain/poll service -- it only
   * bridges the one call site (runClaim) that needs a synchronous result
   * out of Graph.execute()'s fire-and-forget single-agent node dispatch.
   * The existing pending-completion / continuation machinery is untouched
   * and already works correctly once given the chance to reconnect.
   */
  private async awaitReviewWorkflowSettlement(executionId: string, timedOut: () => boolean): Promise<void> {
    const { WorkflowExecutionModel } = await import('../database/models/WorkflowExecutionModel');
    const pollIntervalMs = 1500;
    while (!timedOut()) {
      const execution = await WorkflowExecutionModel.find(executionId).catch(() => null);
      const status = execution?.attributes?.status;
      if (status === 'completed' || status === 'failed' || status === 'suspended') return;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    console.warn(`[TaskDispatcher] awaitReviewWorkflowSettlement: execution ${ executionId } did not settle before verifier timeout`);
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

  private parseProtectedReview(completed: any): ProtectedReviewParseResult {
    if (completed?.outcome !== 'completed' || completed.workflowId !== REVIEW_PROJECT_ARTIFACT_ID) {
      return { value: null, reason: 'workflow_did_not_complete' };
    }
    const synthesis = completed.nodeResults?.find((node: any) => node.nodeId === 'node-review-synthesize');
    const parsed = this.parseJsonObject(synthesis?.result);
    if (!parsed || !['PASS', 'REPAIRABLE', 'REPLAN', 'EXTERNAL_WAIT', 'BLOCKED'].includes(parsed.disposition)) {
      return { value: null, reason: 'missing_or_invalid_disposition' };
    }
    if (typeof parsed.artifactType !== 'string' || !parsed.artifactType.trim()) {
      return { value: null, reason: 'invalid_artifact_type' };
    }
    if (typeof parsed.generationHash !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.generationHash)) {
      return { value: null, reason: 'invalid_generation_hash' };
    }
    const artifactTypes = Array.isArray(parsed.artifactTypes) ? parsed.artifactTypes : [];
    const allowedTypes = new Set(Object.keys(ARTIFACT_VERIFICATION_ADAPTERS));
    if (artifactTypes.length === 0 || artifactTypes.some((value: unknown) => typeof value !== 'string' || !allowedTypes.has(value))) {
      return { value: null, reason: 'invalid_artifact_types_list' };
    }
    if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0) {
      return { value: null, reason: 'empty_artifacts_list' };
    }
    const artifacts = parsed.artifacts.filter((artifact: any) => artifact && typeof artifact === 'object');
    if (artifacts.length !== parsed.artifacts.length || artifacts.some((artifact: any) =>
      !allowedTypes.has(artifact.type) || typeof artifact.canonicalRef !== 'string' ||
      typeof artifact.adapter !== 'string' || typeof artifact.code !== 'boolean' ||
      artifact.adapter !== ARTIFACT_VERIFICATION_ADAPTERS[artifact.type as ReviewArtifactType].adapter ||
      typeof artifact.hash !== 'string' || !/^[a-f0-9]{40,64}$/i.test(artifact.hash))) {
      return { value: null, reason: 'invalid_artifacts_shape' };
    }
    if (typeof parsed.artifactRef !== 'string' || !parsed.artifactRef.trim()) {
      return { value: null, reason: 'invalid_artifact_ref' };
    }
    if (typeof parsed.artifactHash !== 'string' || !/^[a-f0-9]{40,64}$/i.test(parsed.artifactHash)) {
      return { value: null, reason: 'invalid_artifact_hash' };
    }
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
      return { value: null, reason: 'missing_summary' };
    }
    if (!Array.isArray(parsed.checks) || !Array.isArray(parsed.findings)) {
      return { value: null, reason: 'invalid_checks_or_findings' };
    }
    if (parsed.disposition === 'EXTERNAL_WAIT') {
      const wait = parsed.wait;
      if (!wait || !['github_checks', 'human_gate', 'scheduled_time', 'external_job'].includes(wait.kind)) {
        return { value: null, reason: 'invalid_external_wait_kind' };
      }
      if (typeof wait.targetKey !== 'string' || !wait.targetKey.trim()) {
        return { value: null, reason: 'invalid_external_wait_target_key' };
      }
      if (!wait.target || typeof wait.target !== 'object' || Array.isArray(wait.target)) {
        return { value: null, reason: 'invalid_external_wait_target' };
      }
    }
    return {
      value: {
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
      },
      reason: null,
    };
  }

  private async finalizeClaim(
    claim: ClaimedDispatch,
    status: 'completed' | 'blocked' | 'failed',
    summary: string,
  ): Promise<void> {
    const { dispatch, task } = claim;
    const parsed = status === 'completed' ? this.parseWorkResult(summary) : null;
    const malformed = status === 'completed' && !parsed;
    const taskStatus = malformed || status === 'failed' ? task.status : status === 'completed' ? 'in_review' : 'blocked';
    const dispatchStatus = malformed ? 'failed' : status;
    const concise = parsed?.summary ?? summary.slice(0, 1_500);
    const comment = malformed
      ? `Dispatch ${ dispatch.id } stopped before review: no parseable work result was found.`
      : `Dispatch ${ dispatch.id } ${ status } via ${ dispatch.agent_id }: ${ concise }`;
    const receipt = buildReceipt({
      taskId:     task.id,
      eventType:  'execution',
      actor:      'dispatcher',
      dispatchId: dispatch.id,
      disposition: malformed ? 'custody_rejected' : status,
      nextOwner:  taskStatus === 'in_review' ? 'review' : taskStatus,
      validationSummary: concise,
      artifacts: parsed?.custody ? [parsed.custody.workKind === 'code' ? {
        type:         'pull_request',
        canonicalRef: parsed.custody.prUrl ?? undefined,
        url:          parsed.custody.prUrl ?? undefined,
        hash:         parsed.custody.prHeadSha ?? parsed.custody.commitSha ?? undefined,
      } : {
        type:         'authoritative_artifact',
        canonicalRef: parsed.custody.artifactId ?? undefined,
        url:          parsed.custody.artifactUrl ?? undefined,
      }] : [],
      evidence: { kind: 'dispatch', ref: dispatch.id },
    });
    try {
      const journalId = await WorkTaskDispatchModel.appendOutcomeJournal(dispatch.id, task.id, {
        dispatchStatus,
        taskStatus,
        taskAssignee: malformed || status === 'failed' ? 'dispatcher' : 'heartbeat',
        comment: renderReceiptComment(receipt),
        receipt,
        result: status === 'failed' ? undefined : summary,
        error:  status === 'failed' || malformed ? concise : undefined,
        evidence: parsed?.custody ? {
          artifactType:     parsed.custody.workKind === 'code' ? 'code_pull_request' : 'non_code_artifact',
          artifactLocation: parsed.custody.branch ?? parsed.custody.artifactId ?? undefined,
          artifactUrl:      parsed.custody.prUrl ?? parsed.custody.artifactUrl ?? undefined,
          artifactRef:      parsed.custody.prHeadSha ?? parsed.custody.artifactId ?? undefined,
          contentHash:      parsed.custody.commitSha ?? undefined,
          reviewEvidence:   parsed.custody.validation ?? parsed.custody.evidence,
          custody:          parsed.custody,
        } : undefined,
      });
      await WorkTaskDispatchModel.finalizeOutcomeJournal(journalId);
    } catch (err) {
      console.error(`[TaskDispatcher] Could not journal/finalize ${ dispatch.id }:`, err);
    }
  }

  private parseWorkResult(output: string): { summary: string; custody?: import('./ArtifactCustodyPolicy').ArtifactCustody } | null {
    const matches = [...output.matchAll(/<WORK_RESULT>([\s\S]*?)<\/WORK_RESULT>/g)];
    if (matches.length !== 1) return null;
    try {
      const parsed = JSON.parse(matches[0][1].trim());
      if (typeof parsed?.summary !== 'string' || !parsed.summary.trim()) return null;
      // Custody is optional — a worker may omit it entirely. Only reject the
      // whole result when custody is present but structurally malformed.
      const custody = parsed.custody;
      if (custody !== undefined && !ArtifactCustodyPolicy.validate(custody).ok) return null;
      return { summary: parsed.summary.trim().slice(0, 1_500), custody };
    } catch {
      return null;
    }
  }

  /**
   * Project and epic descriptions hold the spec location, decided defaults and
   * source-of-truth rules that task descriptions only cite ("Spec §4"). Without
   * them the worker builds and the reviewer judges against different halves of
   * the contract, and the task bounces.
   */
  /**
   * Every comment, every body in full, oldest to newest. Only if the total
   * exceeds HISTORY_PROMPT_BUDGET_CHARS are the oldest comments left out, with
   * a pointer the agent can follow to read them.
   */
  private fullHistory(taskId: string, comments: { author: string | null; body: string }[]): { author: string; body: string }[] {
    const all = comments.map(comment => ({ author: comment.author || 'unknown', body: comment.body }));
    let total = 0;
    let start = all.length;
    while (start > 0 && total + all[start - 1].body.length <= HISTORY_PROMPT_BUDGET_CHARS) {
      start -= 1;
      total += all[start].body.length;
    }
    if (start === 0) return all;

    return [
      { author: 'dispatcher', body: `${ start } older comment(s) not inlined for size. Read them with: sulla project/list_task_comments '{"task_id":"${ taskId }"}'` },
      ...all.slice(start),
    ];
  }

  private async loadPlanContext(task: WorkTaskRecord): Promise<string> {
    const parts: string[] = [];
    try {
      const project = task.project_id ? await WorkItemsModel.getProject(task.project_id) : null;
      if (project?.description?.trim()) {
        parts.push(`Project "${ project.title }" (${ project.id }):\n${ project.description.trim() }`);
      }
      const epic = task.epic_id ? await WorkItemsModel.getEpic(task.epic_id) : null;
      if (epic?.description?.trim()) {
        parts.push(`Epic "${ epic.title }" (${ epic.id }):\n${ epic.description.trim() }`);
      }
    } catch (err) {
      console.warn(`[TaskDispatcher] Plan context unavailable for ${ task.id }:`, err);
    }

    return parts.length ? parts.join('\n\n') : '(no project or epic description)';
  }

  private buildWorkerPrompt(task: WorkTaskRecord, dispatchId: string, workerAgentId: string, comments: { author: string | null; body: string }[] = [], planContext = '(no project or epic description)'): string {
    const history = this.fullHistory(task.id, comments);
    return `You are the execution worker for Projects task ${ task.id }.

Title: ${ task.title }
Priority: ${ task.priority }
Project: ${ task.project_id }
Epic: ${ task.epic_id ?? '(none)' }
Dispatch: ${ dispatchId }
Current lane: ${ task.status }
Context: ${ JSON.stringify({ assignee: task.assignee, labels: task.labels }) }

Description:
${ task.description || '(no description)' }

Plan context (project and epic descriptions; specs, decided defaults and source-of-truth pointers the task cites live here, so open every file or URL they name before building):
${ planContext }

Task history, oldest to newest (on a repair round the latest review findings are here; fix every one and say how in your receipt):
${ JSON.stringify(history) }

Read active waits and dependencies with Projects tools and reason about what can be advanced now. Labels, assignees, lane names and dependency links are context, not blanket exclusions. Preserve explicit human stops and approvals at the action they cover. Continue unfinished work in this lane yourself. Execute the task autonomously to the reversible edge. Inspect the real state first. For code work, use an isolated worktree/feature branch, verify the change, commit it, push it through the Sulla GitHub tools, and open a draft PR. Do not merge, deploy, spend money, send external communications, or perform destructive shared-system actions. If a truly irreversible dependency remains, return BLOCKED with the exact requirement; reversible uncertainty is yours to decide.

Implement only inside the VM. Keep worktrees under /Users/jonathonbyrdziak/Sites/worktrees. Run tests, builds and typechecks only on GitHub.

You have the same full access as the primary agent: exec and the whole Sulla catalog (projects, GitHub, browser, workflows, sub-agents, everything). Read and comment on any task, including ${ task.id }, and create follow-up tasks when useful. The one coordination rule: the dispatcher moves ${ task.id } between lanes, so don't change its status yourself; return your WORK_RESULT and it goes to independent review.

If CI, tests, or another background check is still running, do not end your turn waiting for it. Report its state as pending in WORK_RESULT, then stop.

Completed work MUST end with exactly one machine block containing at least a summary:
<WORK_RESULT>{"summary":"concise receipt"}</WORK_RESULT>

Custody/evidence metadata is OPTIONAL — attach it when it strengthens the receipt, in whatever shape fits the work. For code work include what you have of branch, commitSha, prUrl, prHeadSha, validation, and provenance, e.g. "custody":{"workKind":"code","branch":"feat/example","commitSha":"FULL_SHA","prUrl":"https://github.com/owner/repo/pull/123","prHeadSha":"FULL_SHA","validation":{"tests":"exact commands and outcomes"},"provenance":{"agentId":"${ workerAgentId }","dispatchId":"${ dispatchId }"}}. For non-code work, "workKind":"non_code" with an artifactId or artifactUrl and evidence is plenty. Omitting custody never blocks the task from entering review; only a missing/duplicate WORK_RESULT block or a structurally malformed custody payload is rejected.`;
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

Review independently. Resolve the actual draft PR/branch and matching local worktree from the task and history. Read the current remote head through the GitHub tools, record the FULL exact head SHA, inspect the diff plus callers/consumers, map every acceptance criterion to evidence, and inspect GitHub CI tests/typecheck evidence for the matching head; never run tests locally. Include tenant, security, and regression analysis when relevant. Re-check the remote head immediately before your verdict; if it changed, do not approve until the matching new head is available and reviewed.

You have exec and the full Sulla catalog: check out and fetch branches, implement missing work, push reversible fixes, and use GitHub CI for tests. Before editing, verify there is no live conflicting execution. If you change the branch head, report REWORK with the new full SHA so the dispatcher rebinds review in this lane. Do not bounce repairable work to planning. The dispatcher applies the transition.

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

  private buildProtectedReviewPrompt(task: WorkTaskRecord, dispatch: ClaimedDispatch['dispatch'], comments: { author: string | null; body: string }[], artifacts: ReviewArtifactComponent[], generationHash: string, excludedAgentIds: string[], planContext = '(no project or epic description)'): string {
    const history = this.fullHistory(task.id, comments);
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
Producer/custodian profile identities (audit only; reviewer independence is enforced by separate workflow node executions): ${ JSON.stringify(excludedAgentIds) }
Adapter catalog: ${ JSON.stringify(ARTIFACT_VERIFICATION_ADAPTERS) }
Tool access: you have exec and the full Sulla catalog (git, github, project, …) through the \`sulla\` CLI or the sulla-native MCP tool \`sulla_tool\` ({"tool":"<bare tool name>","args":{...}}). Check out branches, build, and run whatever tests you need.

Acceptance contract:
${ task.description || '(no description)' }

Plan context (project and epic descriptions; the specs, decided defaults and source-of-truth pointers the contract cites live here, so open every file or URL they name before judging a criterion unverifiable):
${ planContext }

Bounded task evidence, oldest to newest:
${ JSON.stringify(history) }

The dispatcher already owns the collision-safe lease. Review workflow nodes execute serially; finish all writes before returning, never leave background repair writers. Implement in the VM, use /Users/jonathonbyrdziak/Sites/worktrees, and run tests only on GitHub. Inspect the canonical artifact and immutable generation directly. Worker summaries are leads, never proof. Finish missing work in this lane when the change is reversible and no live conflicting edit exists. Preserve actual human approval/stop boundaries. If you push a repair, re-resolve the exact head and return REPAIRABLE with that new generation so the dispatcher rebinds review here; do not route repairable work to planning. The dispatcher records the verdict and transition.`;
  }
}
