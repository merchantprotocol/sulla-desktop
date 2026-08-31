import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Create a NEW task (issue) under an epic. Always inserts — use update_task to
 * change an existing one. Pass parent_id to nest a subtask under another task.
 */
export class CreateTaskWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const epicId = typeof input.epic_id === 'string' ? input.epic_id.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) return { successBoolean: false, responseString: 'title is required to create a task.' };
    if (!epicId) return { successBoolean: false, responseString: 'epic_id is required to create a task.' };

    const parentRaw = input.parent_id;
    const parentId = typeof parentRaw === 'string' && parentRaw.trim() ? parentRaw.trim() : undefined;
    const labels = Array.isArray(input.labels)
      ? input.labels.map((l: any) => String(l)).filter(Boolean)
      : undefined;

    try {
      const projects = getProjectsApplicationService();
      await projects.ready();
      const actor = input.actor || 'sulla';
      const record = await projects.createTask({
        epic_id:      epicId,
        parent_id:    parentId,
        title,
        description:  input.description,
        status:       input.status,
        priority:     input.priority,
        assignee:     input.assignee,
        due_at:       input.due_at === '' ? null : input.due_at,
        labels,
        github_issue: input.github_issue,
        position:     typeof input.position === 'number' ? input.position : undefined,
        source:       input.source || 'agent',
        actor,
      }, { actor, source: 'tool' });

      return {
        successBoolean: true,
        responseString: `Task created: "${ record.title }" (id: ${ record.id }, epic: ${ record.epic_id }, status: ${ record.status }, priority: ${ record.priority })`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to create task: ${ err?.message }` };
    }
  }
}
