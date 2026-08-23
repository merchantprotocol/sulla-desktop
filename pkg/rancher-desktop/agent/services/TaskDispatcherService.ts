import { AbortService } from './AbortService';
import { GraphRegistry } from './GraphRegistry';
import { isInsideWindow } from './HeartbeatService';
import { LifecycleCapabilityModel } from '../database/models/LifecycleCapabilityModel';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import { WorkTaskDispatchModel, type ClaimedDispatch } from '../database/models/WorkTaskDispatchModel';
import { extractAgentTurnOutcome } from '../tools/agents/agentTurnOutcome';
import { findAgentDir } from '../utils/sullaPaths';

const CHECK_INTERVAL_MS = 60_000;
const LEASE_HEARTBEAT_MS = 120_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_AGENT_ID = 'opus-worker';
const RUNTIME_INSTANCE_ID = `task-dispatcher-${ process.pid }-${ Date.now() }`;

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

    await LifecycleCapabilityModel.recoverPreviousRuntime('todo-execution', RUNTIME_INSTANCE_ID);

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

      const configured = Number(await SullaSettingsModel.get('taskDispatcherConcurrency', DEFAULT_CONCURRENCY));
      const concurrency = Math.max(1, Math.min(10, configured || DEFAULT_CONCURRENCY));
      const agentId = String(await SullaSettingsModel.get('taskDispatcherAgentId', DEFAULT_AGENT_ID)).trim() || DEFAULT_AGENT_ID;
      if (!findAgentDir(agentId)) {
        console.error(`[TaskDispatcher] Agent config "${ agentId }" does not exist; dispatch paused`);
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

      let freeSlots = Math.max(0, concurrency - await WorkTaskDispatchModel.countRunning());
      while (freeSlots > 0 && this.initialized) {
        const claim = await WorkTaskDispatchModel.claimNext(agentId, RUNTIME_INSTANCE_ID);
        if (!claim) break;
        this.runClaim(claim).catch(err => console.error('[TaskDispatcher] Worker promise failed:', err));
        freeSlots -= 1;
      }
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

  private async runClaim(claim: ClaimedDispatch): Promise<void> {
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

    try {
      await WorkItemsModel.addComment({
        task_id: task.id,
        author:  'dispatcher',
        body:    `Mechanical dispatch started with ${ dispatch.agent_id } (dispatch ${ dispatch.id }).`,
      }).catch(err => console.error(`[TaskDispatcher] Could not write start comment for ${ dispatch.id }:`, err));

      const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(
        dispatch.agent_id,
        dispatch.thread_id,
        { isTrustedUser: 'trusted' },
      ) as { graph: any; state: any };

      state.messages.push({ role: 'user', content: this.buildWorkerPrompt(task, dispatch.id) });
      state.metadata.isSubAgent = true;
      state.metadata.subAgentDepth = 1;
      state.metadata.workflowParentChannel = 'task-dispatcher';
      state.metadata.options ??= {};
      state.metadata.options.abort = abort;

      const finalState = await graph.execute(state);
      const outcome = extractAgentTurnOutcome(finalState);
      const summary = outcome.text.slice(0, 8_000);

      await this.finalizeClaim(claim, outcome.status, summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finalizeClaim(claim, 'failed', message);
    } finally {
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
}
