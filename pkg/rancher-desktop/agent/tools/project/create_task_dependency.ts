import { WorkTaskDependencyModel, type DependencyRelationType } from '../../database/models/WorkTaskDependencyModel';
import { BaseTool, ToolResponse } from '../base';

const RELATIONS = new Set<DependencyRelationType>(['blocks', 'requires', 'ordered-after']);

/** Create one first-class task dependency. Rejects self-links and cycles transactionally. */
export class CreateTaskDependencyWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const dependentTaskId = typeof input.dependent_task_id === 'string' ? input.dependent_task_id.trim() : '';
    const dependsOnTaskId = typeof input.depends_on_task_id === 'string' ? input.depends_on_task_id.trim() : '';
    const relationRaw = typeof input.relation_type === 'string' && input.relation_type.trim() ? input.relation_type.trim() : 'requires';
    if (!dependentTaskId || !dependsOnTaskId) {
      return { successBoolean: false, responseString: 'dependent_task_id and depends_on_task_id are required.' };
    }
    if (!RELATIONS.has(relationRaw as DependencyRelationType)) {
      return { successBoolean: false, responseString: 'relation_type must be one of blocks, requires, ordered-after.' };
    }
    try {
      const dep = await WorkTaskDependencyModel.create({
        dependentTaskId,
        dependsOnTaskId,
        relationType:         relationRaw as DependencyRelationType,
        acceptanceCondition:  typeof input.acceptance_condition === 'string' && input.acceptance_condition.trim() ? input.acceptance_condition.trim() : null,
        actor:                typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : undefined,
      });
      return {
        successBoolean: true,
        responseString: `Dependency ${ dep.id }: task ${ dep.dependent_task_id } ${ dep.relation_type } ${ dep.depends_on_task_id }. The dependent cannot be claimed until the prerequisite is done.`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to create task dependency: ${ err?.message ?? String(err) }` };
    }
  }
}
