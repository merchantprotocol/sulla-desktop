import { LifecycleCapabilityModel } from '../../database/models/LifecycleCapabilityModel';
import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Update an existing task in place (by id). Only the fields you pass change.
 * This is also the "move" op: pass epic_id to move it to another epic, status
 * to change its column, or position to reorder inside its epic. Moving
 * status/priority/assignee/due_at/parent_id/epic_id stamps last_moved_at; a
 * done/cancelled status also stamps completed_at.
 */
export class UpdateTaskWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return { successBoolean: false, responseString: 'id is required to update a task.' };

    const parentRaw = input.parent_id;
    const parentId = parentRaw === ''
      ? null
      : (typeof parentRaw === 'string' ? parentRaw.trim() : undefined);
    const labels = Array.isArray(input.labels)
      ? input.labels.map((l: any) => String(l)).filter(Boolean)
      : undefined;

    try {
      await WorkItemsModel.ensureTables();
      const actor = input.actor || 'sulla';
      const current = await WorkItemsModel.getTask(id);
      if (!current) return { successBoolean: false, responseString: `No task found with id: ${ id }` };
      if (input.status !== undefined || input.assignee !== undefined) {
        const protectedStatus = typeof input.status === 'string' ? input.status : current.status;
        await LifecycleCapabilityModel.assertActorCanManageTask(
          protectedStatus,
          current.labels,
          actor,
        );
      }
      const updated = await WorkItemsModel.updateTask(id, {
        epic_id:      typeof input.epic_id === 'string' && input.epic_id.trim() ? input.epic_id.trim() : undefined,
        parent_id:    parentId,
        title:        input.title,
        description:  input.description,
        status:       input.status,
        priority:     input.priority,
        assignee:     input.assignee === '' ? null : input.assignee,
        due_at:       input.due_at === '' ? null : input.due_at,
        labels,
        github_issue: input.github_issue === '' ? null : input.github_issue,
        position:     typeof input.position === 'number' ? input.position : undefined,
        source:       input.source,
        actor,
      });
      if (!updated) return { successBoolean: false, responseString: `No task found with id: ${ id }` };

      return {
        successBoolean: true,
        responseString: `Task updated: "${ updated.title }" (id: ${ updated.id }, epic: ${ updated.epic_id }, status: ${ updated.status }, priority: ${ updated.priority }, position: ${ updated.position }, last_moved_at: ${ updated.last_moved_at }, last_activity_at: ${ updated.last_activity_at })`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to update task: ${ err?.message }` };
    }
  }
}
