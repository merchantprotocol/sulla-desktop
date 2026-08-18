import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Append a GitHub-issue-style comment to a task. Append-only.
 */
export class AddTaskCommentWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (!taskId) return { successBoolean: false, responseString: 'task_id is required.' };
    if (!body) return { successBoolean: false, responseString: 'body is required.' };

    try {
      await WorkItemsModel.ensureTables();
      const comment = await WorkItemsModel.addComment({
        task_id: taskId,
        body,
        // Direct Sulla chat is the default author for tool-driven comments;
        // Heartbeat should pass author="heartbeat"; the desktop UI stamps "human".
        author:  input.author || 'sulla',
      });
      return {
        successBoolean: true,
        responseString: `Comment added on task ${ taskId } (id: ${ comment.id }, author: ${ comment.author }).`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to add comment: ${ err?.message }` };
    }
  }
}
