import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * Update an existing work project in place (by id). Only the fields you pass
 * change. Status / priority / due_at changes stamp last_moved_at.
 */
export class UpdateProjectWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return { successBoolean: false, responseString: 'id is required to update a project.' };

    try {
      const projects = getProjectsApplicationService();
      await projects.ready();
      const updated = await projects.updateProject(id, {
        slug:           input.slug,
        title:          input.title,
        description:    input.description,
        outcome_metric: input.outcome_metric,
        status:         input.status,
        priority:       input.priority,
        owner:          input.owner === '' ? null : input.owner,
        due_at:         input.due_at === '' ? null : input.due_at,
        github_repo:    input.github_repo,
        source:         input.source,
      }, { actor: input.actor || 'sulla', source: 'tool' });
      if (!updated) return { successBoolean: false, responseString: `No project found with id: ${ id }` };

      return {
        successBoolean: true,
        responseString: `Project updated: "${ updated.title }" (id: ${ updated.id }, status: ${ updated.status }, priority: ${ updated.priority }, last_moved_at: ${ updated.last_moved_at })`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to update project: ${ err?.message }` };
    }
  }
}
