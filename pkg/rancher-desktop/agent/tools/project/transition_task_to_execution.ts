import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Return a task to its project's first semantic execution lane. */
export class TransitionTaskToExecutionWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    if (!taskId) return { successBoolean: false, responseString: 'task_id is required.' };
    const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'sulla';
    try {
      const result = await getProjectsApplicationService().transitionTaskToExecution({
        taskId,
        expectedGeneration: typeof input.expected_generation === 'number' ? input.expected_generation : undefined,
        custody:            input.custody,
      }, { actor, source: 'routine' });
      return { successBoolean: true, responseString: JSON.stringify(result, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to transition task to execution: ${ error?.message ?? String(error) }` };
    }
  }
}
