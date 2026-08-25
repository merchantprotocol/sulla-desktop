import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

const STATUSES = new Set(['completed', 'failed']);

/** Complete or fail the exact stage-entry generation a workflow run was invoked with. Generation-bound; does not move the task. */
export class SettleStageGenerationWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    const status = typeof input.status === 'string' ? input.status.trim() : '';
    const expectedGeneration = input.expected_generation;
    if (!taskId || !STATUSES.has(status) || !Number.isInteger(expectedGeneration)) {
      return { successBoolean: false, responseString: 'task_id, status (completed|failed), and expected_generation (integer) are required.' };
    }
    try {
      const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'sulla';
      const outcome = input.outcome && typeof input.outcome === 'object' ? input.outcome : undefined;
      const result = await getProjectsApplicationService().settleStageGeneration({
        taskId,
        expectedGeneration,
        status: status as 'completed' | 'failed',
        outcome,
      }, { actor, source: 'routine' });
      return { successBoolean: true, responseString: JSON.stringify(result, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to settle stage generation: ${ error?.message ?? String(error) }` };
    }
  }
}
