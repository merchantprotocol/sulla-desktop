import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Move a task to the next or previous stage in its project's configured order. */
export class TransitionTaskRelativeWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    const direction = input.direction === 'previous' ? 'previous' : input.direction === 'next' ? 'next' : null;
    if (!taskId || !direction) {
      return { successBoolean: false, responseString: 'task_id and direction (next or previous) are required.' };
    }
    const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'sulla';
    try {
      const result = await getProjectsApplicationService().transitionTaskRelative({
        taskId,
        direction,
        expectedGeneration: typeof input.expected_generation === 'number' ? input.expected_generation : undefined,
        custody:            input.custody,
      }, { actor, source: 'routine' });
      return { successBoolean: true, responseString: JSON.stringify(result, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to transition task stage: ${ error?.message ?? String(error) }` };
    }
  }
}
