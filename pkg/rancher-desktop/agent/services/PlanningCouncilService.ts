import { WorkItemsModel, type WorkTaskRecord } from '../database/models/WorkItemsModel';
import { WorkLaneDefinitionModel, type WorkLaneSemanticRole } from '../database/models/WorkLaneDefinitionModel';
import {
  PROJECT_TASK_PLANNING_WORKFLOW_ID,
  WorkTaskPlanningRunModel,
  type ClaimedPlanningRun,
} from '../database/models/WorkTaskPlanningRunModel';
import { WorkflowModel } from '../database/models/WorkflowModel';

const MAX_DESCRIPTION_CHARS = 12_000;
const MAX_CONTEXT_DESCRIPTION_CHARS = 4_000;
const MAX_COMMENTS = 50;
const MAX_COMMENT_CHARS = 4_000;

function bounded(value: string | null | undefined, max: number): string {
  return String(value ?? '').slice(0, max);
}

async function taskRole(task: WorkTaskRecord): Promise<WorkLaneSemanticRole> {
  const capability = await WorkLaneDefinitionModel.runtimeCapability(task.project_id);
  if (capability.ready) {
    return (await WorkLaneDefinitionModel.resolveStatus(task.project_id, task.status))?.semantic_role ?? 'manual';
  }
  if (task.status === 'planning') return 'planning';
  if (task.status === 'blocked') return 'blocked';
  return 'manual';
}

export class PlanningCouncilService {
  /** Called after a Projects task update has committed. */
  static async handleTaskStatusTransition(
    task: WorkTaskRecord,
    previousStatus: string,
    actor?: string,
  ): Promise<void> {
    const currentRole = await taskRole(task);
    if (currentRole !== 'blocked' && currentRole !== 'planning') {
      const settled = await WorkTaskPlanningRunModel.settleForTask(
        task.id,
        'completed',
      );
      if (settled) {
        await WorkItemsModel.addComment({
          task_id: task.id,
          author:  'planning-council',
          body:    `Planning council ${ settled.id } completed; task returned to ${ task.status }${ task.assignee ? `/${ task.assignee }` : '' }.`,
        });
      }
      return;
    }

    // planning -> blocked is the council's explicit irreversible-gate outcome.
    // Settle it; do not recursively create another council for the same result.
    const previousLane = await WorkLaneDefinitionModel.resolveStatus(task.project_id, previousStatus);
    const previousRole = previousLane?.semantic_role ?? (previousStatus === 'planning' ? 'planning' : 'manual');
    if (previousRole === 'planning' && currentRole === 'blocked') {
      const settled = await WorkTaskPlanningRunModel.settleForTask(task.id, 'blocked');
      if (settled) {
        await WorkItemsModel.addComment({
          task_id: task.id,
          author:  'planning-council',
          body:    `Planning council ${ settled.id } preserved a genuine gate; task remains blocked.`,
        });
      }
      return;
    }

    await PlanningCouncilService.claimAndLaunch(task.id, task.status, actor);
  }

  static async recoverOnStartup(): Promise<void> {
    const taskIds = await WorkTaskPlanningRunModel.recoverStale(0);
    for (const taskId of taskIds) {
      await WorkItemsModel.addComment({
        task_id: taskId,
        author:  'planning-council',
        body:    'Recovered a planning council interrupted by restart; retrying with a new durable claim.',
      }).catch(err => console.warn(`[PlanningCouncil] Could not audit recovery for ${ taskId }:`, err));
      const task = await WorkItemsModel.getTask(taskId);
      if (task && ['blocked', 'planning'].includes(await taskRole(task))) {
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
    if (!task || await taskRole(task) !== 'planning') return;

    const reason = outcome === 'completed'
      ? 'Planning routine completed without persisting a final plan and state transition.'
      : `Planning routine failed: ${ bounded(error || 'unknown error', 1_000) }`;
    await WorkTaskPlanningRunModel.settleForTask(task.id, 'failed', reason);
    await WorkItemsModel.addComment({
      task_id: task.id,
      author:  'planning-council',
      body:    `${ reason } The durable run is closed and the task is blocked for an auditable retry.`,
    });
    const blockedLane = await WorkLaneDefinitionModel.preferredLaneKey(task.project_id, 'blocked', 'blocked');
    await WorkItemsModel.updateTask(task.id, {
      status:   blockedLane,
      assignee: 'heartbeat',
      actor:    'planning-council',
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

    await WorkItemsModel.addComment({
      task_id: claim.task.id,
      author:  'planning-council',
      body:    `Planning council claimed (run ${ claim.run.id }, attempt ${ claim.run.attempt }, trigger ${ triggerStatus }, actor ${ actor || 'unknown' }).`,
    });

    try {
      const snapshot = await PlanningCouncilService.buildSnapshot(claim);
      const { executeRoutine } = await import('@pkg/main/sullaRoutineTemplateEvents');
      const execution = await executeRoutine(
        PROJECT_TASK_PLANNING_WORKFLOW_ID,
        JSON.stringify(snapshot),
        { allowConcurrent: true },
      );
      await WorkTaskPlanningRunModel.attachExecution(claim.run.id, execution.playbookExecutionId ?? execution.executionId);
      await WorkItemsModel.addComment({
        task_id: claim.task.id,
        author:  'planning-council',
        body:    `Planning council execution started: ${ execution.playbookExecutionId ?? execution.executionId } (run ${ claim.run.id }).`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await WorkTaskPlanningRunModel.settleForTask(claim.task.id, 'failed', message);
      await WorkItemsModel.addComment({
        task_id: claim.task.id,
        author:  'planning-council',
        body:    `Planning council launch failed (run ${ claim.run.id }): ${ bounded(message, 1_000) }`,
      });
      const blockedLane = await WorkLaneDefinitionModel.preferredLaneKey(claim.task.project_id, 'blocked', 'blocked');
      await WorkItemsModel.updateTask(claim.task.id, {
        status:   blockedLane,
        assignee: 'heartbeat',
        actor:    'planning-council',
      });
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
        semantic_role:    'planning',
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
