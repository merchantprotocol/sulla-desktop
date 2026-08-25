import { WorkLaneDefinitionModel, type WorkLaneSemanticRole } from '../../database/models/WorkLaneDefinitionModel';

import type { WorkTaskRecord } from '../../database/models/WorkItemsModel';

const FALLBACK_ROLE_KEYS: Record<WorkLaneSemanticRole, string[]> = {
  backlog:   ['backlog'],
  planning:  ['planning'],
  execution: ['todo', 'in_progress'],
  review:    ['in_review'],
  blocked:   ['blocked'],
  terminal:  ['done', 'cancelled'],
  manual:    ['parked'],
};

function fallbackRole(status: string): WorkLaneSemanticRole {
  if (FALLBACK_ROLE_KEYS.planning.includes(status)) return 'planning';
  if (FALLBACK_ROLE_KEYS.blocked.includes(status)) return 'blocked';
  if (FALLBACK_ROLE_KEYS.execution.includes(status)) return 'execution';
  if (FALLBACK_ROLE_KEYS.review.includes(status)) return 'review';
  if (FALLBACK_ROLE_KEYS.terminal.includes(status)) return 'terminal';
  if (FALLBACK_ROLE_KEYS.backlog.includes(status)) return 'backlog';
  return 'manual';
}

/** Idempotent orchestration reactions to an already-committed task transition. */
export class TaskLifecycleOrchestrationService {
  static async handleCommittedTransition(
    task: WorkTaskRecord,
    previousStatus: string,
    actor?: string,
  ): Promise<void> {
    const capability = await WorkLaneDefinitionModel.runtimeCapability(task.project_id);
    const currentRole = capability.ready
      ? (await WorkLaneDefinitionModel.resolveStatus(task.project_id, task.status))?.semantic_role ?? 'manual'
      : fallbackRole(task.status);
    const previousRole = capability.ready
      ? (await WorkLaneDefinitionModel.resolveStatus(task.project_id, previousStatus))?.semantic_role ?? 'manual'
      : fallbackRole(previousStatus);

    if ([currentRole, previousRole].some(role => role === 'blocked' || role === 'planning')) {
      const { PlanningCouncilService } = await import('../../services/PlanningCouncilService');
      await PlanningCouncilService.handleTaskStatusTransition(task, previousStatus, actor);
    }
    if (currentRole === 'execution' && previousRole !== 'execution') {
      const { getTaskDispatcherService } = await import('../../services/TaskDispatcherService');
      await getTaskDispatcherService().forceCheck();
    }
  }
}
