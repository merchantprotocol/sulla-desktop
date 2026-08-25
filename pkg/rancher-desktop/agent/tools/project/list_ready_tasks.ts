import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

/** Bulk readiness query: tasks in a project (optionally one epic) split into ready vs dependency-blocked, with exact holds. */
export class ListReadyTasksWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const projectId = typeof input.project_id === 'string' ? input.project_id.trim() : '';
    if (!projectId) return { successBoolean: false, responseString: 'project_id is required.' };
    const epicId = typeof input.epic_id === 'string' && input.epic_id.trim() ? input.epic_id.trim() : undefined;
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : undefined;
    try {
      const result = await getProjectsApplicationService().readyTasks({ projectId, epicId, limit });
      return { successBoolean: true, responseString: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to list ready tasks: ${ err?.message ?? String(err) }` };
    }
  }
}
