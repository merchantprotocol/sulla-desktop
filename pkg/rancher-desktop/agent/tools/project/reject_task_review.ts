import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Record generation-bound repair findings; retain the current lane and live writer. */
export class RejectTaskReviewWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (!taskId) return { successBoolean: false, responseString: 'task_id is required.' };
    if (!summary) return { successBoolean: false, responseString: 'summary (rejection rationale) is required.' };
    const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'heartbeat';

    try {
      const result = await getProjectsApplicationService().rejectTaskReview(
        { taskId, summary, expectedGeneration: input.expected_generation },
        { actor, source: 'routine' },
      );
      if (!result.settled) {
        return {
          successBoolean: true,
          responseString: `Task ${ taskId } was already settled out of this review generation; no-op.`,
        };
      }
      return {
        successBoolean: true,
        responseString: `Task ${ taskId } has repair findings recorded in ${ result.task?.status }; its writer retains ownership.`,
      };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to reject task review: ${ error?.message ?? String(error) }` };
    }
  }
}
