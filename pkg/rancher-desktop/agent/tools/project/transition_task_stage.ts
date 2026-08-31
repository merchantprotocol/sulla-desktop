import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Move a task to one explicit project-configured stage. */
export class TransitionTaskStageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    const stageKey = typeof input.stage_key === 'string' ? input.stage_key.trim() : '';
    if (!taskId || !stageKey) {
      return { successBoolean: false, responseString: 'task_id and stage_key are required.' };
    }
    const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'sulla';
    try {
      const result = await getProjectsApplicationService().transitionTaskStage({
        taskId,
        stageKey,
        expectedGeneration: typeof input.expected_generation === 'number' ? input.expected_generation : undefined,
        custody:            input.custody,
      }, { actor, source: 'routine' });
      return { successBoolean: true, responseString: JSON.stringify(result, null, 2) };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to transition task stage: ${ error?.message ?? String(error) }` };
    }
  }
}
