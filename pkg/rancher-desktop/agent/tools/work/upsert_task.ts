import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Create or update a task (GitHub-issue shaped). parent_id nests a subtask.
 */
export class UpsertTaskWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const epicId = typeof input.epic_id === 'string' ? input.epic_id.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const parentRaw = input.parent_id;
    const parentId = parentRaw === '' ? null
      : (typeof parentRaw === 'string' ? parentRaw.trim() : undefined);

    if (!id && !title) {
      return { successBoolean: false, responseString: 'title is required to create a task (or pass id to update).' };
    }
    if (!id && !epicId) {
      return { successBoolean: false, responseString: 'epic_id is required to create a task.' };
    }

    try {
      await WorkItemsModel.ensureTables();

      const labels = Array.isArray(input.labels)
        ? input.labels.map((l: any) => String(l)).filter(Boolean)
        : undefined;

      if (id) {
        const updated = await WorkItemsModel.updateTask(id, {
          epic_id:      epicId || undefined,
          parent_id:    parentId,
          title:        title || undefined,
          description:  input.description,
          status:       input.status,
          priority:     input.priority,
          assignee:     input.assignee === '' ? null : input.assignee,
          due_at:       input.due_at === '' ? null : input.due_at,
          labels,
          github_issue: input.github_issue === '' ? null : input.github_issue,
          position:     input.position,
          source:       input.source,
        });
        if (!updated) {
          return { successBoolean: false, responseString: `No task found with id: ${ id }` };
        }
        return {
          successBoolean: true,
          responseString: `Task updated: "${ updated.title }" (id: ${ updated.id }, status: ${ updated.status }, priority: ${ updated.priority }, last_moved_at: ${ updated.last_moved_at })`,
        };
      }

      const record = await WorkItemsModel.insertTask({
        epic_id:      epicId,
        parent_id:    typeof parentId === 'string' ? parentId : undefined,
        title,
        description:  input.description,
        status:       input.status,
        priority:     input.priority,
        assignee:     input.assignee,
        due_at:       input.due_at === '' ? null : input.due_at,
        labels,
        github_issue: input.github_issue,
        position:     input.position,
        source:       input.source || 'agent',
      });
      return {
        successBoolean: true,
        responseString: `Task created: "${ record.title }" (id: ${ record.id }, epic: ${ record.epic_id }, status: ${ record.status }, priority: ${ record.priority })`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to save task: ${ err?.message }` };
    }
  }
}
