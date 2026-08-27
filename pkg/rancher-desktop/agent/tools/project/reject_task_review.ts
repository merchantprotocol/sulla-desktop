import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Settle an in-review task with a REJECTED verdict and atomically hand it
 * back to todo-execution for repair (#727). This is a dedicated, narrowly
 * scoped transition — not update_task — because the acting in-review
 * authority (the protected review routine, or its explicitly named
 * Heartbeat fallback) does not own todo-execution and update_task's guard
 * correctly denies a generic status edit across that boundary. This tool's
 * own authorization check requires the caller to be the effective owner of
 * in-review-verification at call time; everyone else is denied. Calling it
 * twice for a task that has already left in_review is a safe no-op.
 */
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
        { taskId, summary },
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
        responseString: `Task ${ taskId } rejected and handed back to todo-execution (assignee: ${ result.task?.assignee ?? 'dispatcher' }).`,
      };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to reject task review: ${ error?.message ?? String(error) }` };
    }
  }
}
