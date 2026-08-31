import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Soft-archive one task dependency by id, or by dependent+depends_on(+relation). */
export class RemoveTaskDependencyWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined;
    const dependentTaskId = typeof input.dependent_task_id === 'string' && input.dependent_task_id.trim() ? input.dependent_task_id.trim() : undefined;
    const dependsOnTaskId = typeof input.depends_on_task_id === 'string' && input.depends_on_task_id.trim() ? input.depends_on_task_id.trim() : undefined;
    if (!id && (!dependentTaskId || !dependsOnTaskId)) {
      return { successBoolean: false, responseString: 'Provide id, or both dependent_task_id and depends_on_task_id.' };
    }
    try {
      const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'sulla';
      const removed = await getProjectsApplicationService().removeDependency({
        id,
        dependentTaskId,
        dependsOnTaskId,
        relationType: typeof input.relation_type === 'string' && input.relation_type.trim() ? input.relation_type.trim() : undefined,
      }, { actor, source: 'tool' });
      return { successBoolean: true, responseString: removed ? 'Dependency removed (soft-archived).' : 'No matching active dependency found.' };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to remove task dependency: ${ err?.message ?? String(err) }` };
    }
  }
}
