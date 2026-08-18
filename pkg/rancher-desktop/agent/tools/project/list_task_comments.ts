import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * List the comment thread on a task, oldest first. Append-only history.
 */
export class ListTaskCommentsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    if (!taskId) return { successBoolean: false, responseString: 'task_id is required.' };

    try {
      await WorkItemsModel.ensureTables();
      const comments = await WorkItemsModel.listComments(taskId);
      if (!comments.length) {
        return { successBoolean: true, responseString: `No comments on task ${ taskId }.` };
      }
      const lines = comments.map(c => `- [${ c.created_at }] ${ c.author || 'agent' }: ${ c.body }`);

      return {
        successBoolean: true,
        responseString: `${ comments.length } comment(s) on task ${ taskId }:\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to list comments: ${ err?.message }` };
    }
  }
}
