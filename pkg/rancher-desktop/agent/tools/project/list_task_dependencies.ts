import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** List a task's dependencies (its prerequisites) and its dependents. Read-only. */
export class ListTaskDependenciesWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    if (!taskId) return { successBoolean: false, responseString: 'task_id is required.' };
    try {
      const includeArchived = input.include_archived === true;
      const projects = getProjectsApplicationService();
      const [dependencies, dependents] = await Promise.all([
        projects.listDependencies(taskId, { includeArchived }),
        projects.listDependents(taskId, { includeArchived }),
      ]);
      return { successBoolean: true, responseString: JSON.stringify({ taskId, dependencies, dependents }, null, 2) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to list task dependencies: ${ err?.message ?? String(err) }` };
    }
  }
}
