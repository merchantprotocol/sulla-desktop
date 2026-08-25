import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Update an existing epic in place (by id). Only the fields you pass change.
 * Moving it to another project, or changing status / priority / due_at,
 * stamps last_moved_at. `position` reorders it inside the project.
 */
export class UpdateEpicWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return { successBoolean: false, responseString: 'id is required to update an epic.' };

    try {
      const projects = getProjectsApplicationService();
      await projects.ready();
      const updated = await projects.updateEpic(id, {
        project_id:  input.project_id,
        slug:        input.slug,
        title:       input.title,
        description: input.description,
        status:      input.status,
        priority:    input.priority,
        position:    typeof input.position === 'number' ? input.position : undefined,
        due_at:      input.due_at === '' ? null : input.due_at,
        source:      input.source,
      }, { actor: input.actor || 'sulla', source: 'tool' });
      if (!updated) return { successBoolean: false, responseString: `No epic found with id: ${ id }` };

      return {
        successBoolean: true,
        responseString: `Epic updated: "${ updated.title }" (id: ${ updated.id }, status: ${ updated.status }, priority: ${ updated.priority }, position: ${ updated.position }, last_moved_at: ${ updated.last_moved_at })`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to update epic: ${ err?.message }` };
    }
  }
}
