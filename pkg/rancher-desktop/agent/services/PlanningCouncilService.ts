import { WorkLaneDefinitionModel } from '../database/models/WorkLaneDefinitionModel';
import { WorkItemsModel, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import {
  PROJECT_TASK_PLANNING_WORKFLOW_ID,
  WorkTaskPlanningRunModel,
  type ClaimedPlanningRun,
} from '../database/models/WorkTaskPlanningRunModel';
import { WorkflowModel } from '../database/models/WorkflowModel';
import { WorkflowExecutionModel } from '../database/models/WorkflowExecutionModel';
import { recordReceipt } from './ArtifactReceiptService';

// Planners get all the information: no description, comment-count or
// comment-length caps (every lane is treated the same).
const MAX_DESCRIPTION_CHARS = Number.POSITIVE_INFINITY;
const MAX_CONTEXT_DESCRIPTION_CHARS = Number.POSITIVE_INFINITY;
const MAX_COMMENTS = Number.POSITIVE_INFINITY;
const MAX_COMMENT_CHARS = Number.POSITIVE_INFINITY;

function bounded(value: string | null | undefined, max: number): string {
  return String(value ?? '').slice(0, max);
}

export class PlanningCouncilService {
  /** Called after a Projects task update has committed. */
  static async handleTaskStatusTransition(
    task: WorkTaskRecord,
    _previousStatus: string,
    actor?: string,
  ): Promise<void> {
    const role = await WorkLaneDefinitionModel.semanticRoleForStatus(task.project_id, task.status);
    // A status update can run inside the recordkeeper's tool call. Only
    // the drained workflow terminal callback may release its reservation.
    if (!['blocked', 'planning'].includes(role)) return;
    if (actor === 'planning-council' && role === 'blocked') return;

    await PlanningCouncilService.claimAndLaunch(task.id, task.status, actor);
  }

  static async recoverOnStartup(): Promise<void> {
    await WorkflowExecutionModel.reapStaleLeaselessExecutions();
    const taskIds = await WorkTaskPlanningRunModel.recoverStale(45);
    for (const taskId of taskIds) {
      await WorkItemsModel.addComment({
        task_id: taskId,
        author:  'planning-council',
        body:    'Recovered a planning council interrupted by restart; retrying with a new durable claim.',
      }).catch(err => console.warn(`[PlanningCouncil] Could not audit recovery for ${ taskId }:`, err));
      const task = await WorkItemsModel.getTask(taskId);
      if (task && ['blocked', 'planning'].includes(await WorkLaneDefinitionModel.semanticRoleForStatus(task.project_id, task.status))) {
        await PlanningCouncilService.claimAndLaunch(taskId, task.status, 'startup-recovery');
      }
    }
  }

  /** Controller callback for a workflow that stopped before moving the task. */
  static async handleWorkflowFinished(
    executionId: string,
    outcome: 'completed' | 'failed',
    error?: string,
  ): Promise<void> {
    const run = await WorkTaskPlanningRunModel.findActiveByExecution(executionId);
    if (!run) return;

    const task = await WorkItemsModel.getTask(run.task_id);
    if (!task) {
      await WorkTaskPlanningRunModel.settleForTask(run.task_id, 'failed', 'Task no longer exists');
      return;
    }

    const role = await WorkLaneDefinitionModel.semanticRoleForStatus(task.project_id, task.status);
    if (outcome === 'completed' && role !== 'planning') {
      const disposition = role === 'blocked' ? 'blocked' : 'completed';
      await WorkTaskPlanningRunModel.settleForTask(task.id, disposition);
      await recordReceipt({
        taskId: task.id, eventType: 'planning', actor: 'planning-council',
        workflowExecutionId: executionId, disposition,
        nextOwner: task.assignee ?? 'complete',
        validationSummary: `Planning writers stopped with task in ${ task.status }.`,
        artifacts: [{ type: 'planning_run', canonicalRef: run.id }],
        evidence: { kind: 'workflow_execution', ref: executionId },
      });
      return;
    }

    const reason = outcome === 'completed'
      ? 'Planning routine completed without persisting a final plan and state transition.'
      : `Planning routine failed: ${ bounded(error || 'unknown error', 1_000) }`;
    await WorkTaskPlanningRunModel.settleForTask(task.id, 'failed', reason);
    await recordReceipt({
      taskId: task.id, eventType: 'planning', actor: 'planning-council',
      workflowExecutionId: executionId,
      disposition: outcome, nextOwner: 'heartbeat', validationSummary: reason,
      artifacts: [{ type: 'planning_run', canonicalRef: run.id }],
      evidence: { kind: 'workflow_execution', ref: executionId },
    });
  }

  private static async claimAndLaunch(
    taskId: string,
    triggerStatus: string,
    actor?: string,
  ): Promise<void> {
    const workflow = await WorkflowModel.findById(PROJECT_TASK_PLANNING_WORKFLOW_ID);
    if (workflow?.attributes.system !== true || workflow.attributes.status !== 'production' || workflow.attributes.enabled !== true) {
      return;
    }

    const recovered = await WorkTaskPlanningRunModel.recoverStaleForTask(taskId, 45);
    if (recovered) {
      await WorkItemsModel.addComment({
        task_id: taskId,
        author:  'planning-council',
        body:    'Recovered a stale planning council during a Projects status event; retrying with a new claim.',
      });
    }

    const claim = await WorkTaskPlanningRunModel.claim(taskId, triggerStatus, actor);
    if (!claim) return;

    let launchAttempted = false;
    try {
      await WorkItemsModel.addComment({
        task_id: claim.task.id,
        author:  'planning-council',
        body:    `Planning council claimed (run ${ claim.run.id }, attempt ${ claim.run.attempt }, trigger ${ triggerStatus }, actor ${ actor || 'unknown' }).`,
      });
      const snapshot = await PlanningCouncilService.buildSnapshot(claim);
      const { executeRoutine } = await import('@pkg/main/sullaRoutineTemplateEvents');
      // A launch error can occur after a child starts. Retain ownership until
      // its terminal callback confirms termination, including bookkeeping errors.
      launchAttempted = true;
      const execution = await executeRoutine(
        PROJECT_TASK_PLANNING_WORKFLOW_ID,
        JSON.stringify(snapshot),
        { allowConcurrent: true, routineKind: 'planning', waitForCapacity: true },
      );
      await WorkTaskPlanningRunModel.attachExecution(claim.run.id, execution.playbookExecutionId ?? execution.executionId);
      await WorkItemsModel.addComment({
        task_id: claim.task.id,
        author:  'planning-council',
        body:    `Planning council execution started: ${ execution.playbookExecutionId ?? execution.executionId } (run ${ claim.run.id }).`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!launchAttempted) await WorkTaskPlanningRunModel.settleForTask(claim.task.id, 'failed', message);
      await WorkItemsModel.addComment({
        task_id: claim.task.id,
        author:  'planning-council',
        body:    `Planning council launch/bookkeeping failed; ${ launchAttempted ? 'ownership retained pending termination' : 'no workflow started' } (run ${ claim.run.id }): ${ bounded(message, 1_000) }`,
      }).catch(auditError => console.warn('[PlanningCouncil] Could not audit launch failure:', auditError));
    }
  }

  private static async buildSnapshot(claim: ClaimedPlanningRun): Promise<Record<string, unknown>> {
    const { task, run } = claim;
    const [project, epic, allComments] = await Promise.all([
      WorkItemsModel.getProject(task.project_id),
      task.epic_id ? WorkItemsModel.getEpic(task.epic_id) : Promise.resolve(null),
      WorkItemsModel.listComments(task.id),
    ]);
    const comments = allComments.slice(-MAX_COMMENTS).map(comment => ({
      author:     bounded(comment.author, 120),
      created_at: comment.created_at,
      body:       bounded(comment.body, MAX_COMMENT_CHARS),
    }));
    const originalBlocker = [...comments].reverse().find(comment => comment.author !== 'planning-council')?.body ||
      bounded(task.description, MAX_COMMENT_CHARS);

    return {
      planning_run: {
        id:             run.id,
        attempt:        run.attempt,
        trigger_status: run.trigger_status,
      },
      task: {
        id:               task.id,
        title:            bounded(task.title, 500),
        description:      bounded(task.description, MAX_DESCRIPTION_CHARS),
        status:           task.status,
        priority:         task.priority,
        assignee:         task.assignee,
        labels:           task.labels ?? [],
        github_issue:     task.github_issue,
        original_blocker: originalBlocker,
      },
      project: project
        ? {
          id:             project.id,
          title:          bounded(project.title, 500),
          description:    bounded(project.description, MAX_CONTEXT_DESCRIPTION_CHARS),
          outcome_metric: bounded(project.outcome_metric, 1_000),
          github_repo:    project.github_repo,
        }
        : null,
      epic: epic
        ? {
          id:          epic.id,
          title:       bounded(epic.title, 500),
          description: bounded(epic.description, MAX_CONTEXT_DESCRIPTION_CHARS),
        }
        : null,
      comments,
      safety: {
        forbidden: ['merge', 'deploy', 'spend money', 'external communication', 'destructive shared-system action'],
        rule:      'Ordinary reversible uncertainty must be decided by the council, not escalated.',
      },
    };
  }
}
