import { AbortService } from './AbortService';
import { GraphRegistry } from './GraphRegistry';
import { isInsideWindow } from './HeartbeatService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import { WorkTaskDispatchModel, type ClaimedDispatch, type WorkTaskDispatchEvidence } from '../database/models/WorkTaskDispatchModel';
import { WorkflowModel } from '../database/models/WorkflowModel';
import { EXECUTE_PROJECT_TODO_DEFINITION, EXECUTE_PROJECT_TODO_ID } from '../routines/core/executeProjectTodo';
import { extractAgentTurnOutcome } from '../tools/agents/agentTurnOutcome';
import { findAgentDir } from '../utils/sullaPaths';
import { createPlaybookState } from '../workflow/WorkflowPlaybook';

import type { WorkflowPlaybookState } from '../workflow/types';

const CHECK_INTERVAL_MS = 60_000;
const LEASE_HEARTBEAT_MS = 120_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_AGENT_ID = 'opus-worker';
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

      const configured = Number(await SullaSettingsModel.get('taskDispatcherConcurrency', DEFAULT_CONCURRENCY));
      const concurrency = Math.max(1, Math.min(10, configured || DEFAULT_CONCURRENCY));
      const agentId = String(await SullaSettingsModel.get('taskDispatcherAgentId', DEFAULT_AGENT_ID)).trim() || DEFAULT_AGENT_ID;
      if (!findAgentDir(agentId)) {
        console.error(`[TaskDispatcher] Agent config "${ agentId }" does not exist; dispatch paused`);
        return;
      }

      const executionOwner = await this.resolveExecutionOwner();
      if (!executionOwner) return;

      let freeSlots = Math.max(0, concurrency - await WorkTaskDispatchModel.countRunning());
      while (freeSlots > 0 && this.initialized) {
        const claim = await WorkTaskDispatchModel.claimNext(agentId, executionOwner === 'core-routine' ? 'core-todo' : 'legacy-worker');
        if (!claim) break;
        this.runClaim(claim, executionOwner).catch(err => console.error('[TaskDispatcher] Worker promise failed:', err));
        freeSlots -= 1;
      }
    } catch (err) {
      console.error('[TaskDispatcher] Dispatch check failed:', err);
    } finally {
      this.checking = false;
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

      const taskPrompt = await this.buildWorkerPrompt(task, dispatch.id);
      state.messages.push({ role: 'user', content: taskPrompt });
      state.metadata.isSubAgent = true;
      state.metadata.subAgentDepth = 1;
      state.metadata.workflowParentChannel = 'task-dispatcher';
      state.metadata.options ??= {};
      state.metadata.options.abort = abort;

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

      const finalState = await graph.execute(state);
      const outcome = extractAgentTurnOutcome(finalState);
      const summary = outcome.text.slice(0, 8_000);

      await this.finalizeClaim(claim, outcome.status, summary, executionOwner, finalState.metadata?.activeWorkflow);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finalizeClaim(claim, 'failed', message, executionOwner);
    } finally {
      clearInterval(leaseTimer);
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
    executionOwner: ExecutionOwner,
    playbook?: WorkflowPlaybookState,
  ): Promise<void> {
    const { dispatch, task } = claim;
    const evidence = playbook ? this.extractWorkflowEvidence(playbook) : null;
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
      : `Dispatch ${ dispatch.id } ${ status } via ${ dispatch.agent_id }.\n\n${ summary }`;

    await WorkTaskDispatchModel.finalize(dispatch.id, task.id, {
      dispatchStatus,
      taskStatus,
      taskAssignee: assignee,
      comment,
      result,
      error,
      evidence:     evidence?.ledger,
    });
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

  private extractWorkflowEvidence(playbook: WorkflowPlaybookState): {
    ledger:         WorkTaskDispatchEvidence;
    nextState:      'in_review' | 'planning' | 'blocked';
    contractValid:  boolean;
    contractError?: string;
  } {
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
    const workType = String(classifier?.workType || '').toLowerCase();
    const isCode = workType.includes('coding') || workType.includes('repository') || String(custody?.artifactType || '').toLowerCase() === 'code';
    const hasReviewEvidence = review?.evidence !== undefined && review?.evidence !== null && JSON.stringify(review.evidence).length > 2;
    const hasVerification = custody?.verificationEvidence !== undefined && custody?.verificationEvidence !== null && JSON.stringify(custody.verificationEvidence).length > 2;
    const hasStableArtifact = Boolean(custody?.artifactUrl || custody?.artifactLocation || custody?.artifactRef);
    const headSha = String(custody?.headSha || '');
    const hasCodeCustody = !isCode || (
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(String(custody?.artifactUrl || '')) &&
      Boolean(custody?.artifactRef) &&
      /^[0-9a-f]{7,40}$/i.test(headSha) &&
      String(custody?.contentHash || '') === headSha
    );
    const passContract = custodyVerdict === 'pass' &&
      ['pass', 'repaired'].includes(repairRoute) &&
      reviewerVerdict === 'pass' &&
      hasReviewEvidence &&
      hasVerification &&
      hasStableArtifact &&
      hasCodeCustody &&
      record?.recorded === true;
    const explicitExternalBlock = custodyVerdict === 'blocked' &&
      repairRoute === 'blocked' &&
      Boolean(custody?.terminalReason) &&
      hasReviewEvidence;
    const contractValid = passContract || explicitExternalBlock || repairRoute === 'replan';
    const contractError = contractValid ? undefined : 'structured review or durable artifact custody evidence is incomplete';
    const nextState = passContract
      ? 'in_review'
      : explicitExternalBlock
        ? 'blocked'
        : 'planning';

    return {
      nextState,
      contractValid,
      contractError,
      ledger: {
        workflowExecutionId: playbook.executionId,
        classifierDecision:  classifier ?? undefined,
        selectedAgents:      Array.isArray(classifier?.selectedAgents) ? classifier.selectedAgents : undefined,
        workerChildIds:      Array.isArray(workers?.childIds) ? workers.childIds.map(String) : undefined,
        reviewCount:         review ? 1 : 0,
        repairCount:         repairRoute === 'repaired' ? 1 : 0,
        artifactType:        custody?.artifactType,
        artifactLocation:    custody?.artifactLocation,
        artifactUrl:         custody?.artifactUrl,
        artifactRef:         custody?.artifactRef || custody?.headSha,
        contentHash:         custody?.contentHash || custody?.headSha,
        reviewerVerdict,
        reviewEvidence:      review?.evidence ?? review ?? undefined,
        terminalReason:      custody?.terminalReason || contractError || (nextState === 'planning' ? 'acceptance_or_custody_incomplete' : undefined),
      },
    };
  }

  private async buildWorkerPrompt(task: WorkTaskRecord, dispatchId: string): Promise<string> {
    const comments = await WorkItemsModel.listComments(task.id);
    const boundedComments = comments.slice(-50).map(comment => ({
      author:     comment.author,
      body:       comment.body.slice(0, 4_000),
      created_at: comment.created_at,
    }));

    return `You are executing the locked core todo routine for Projects task ${ task.id }.

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
}
