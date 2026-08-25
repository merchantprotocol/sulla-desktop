import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class ResolveLanesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const projectId = String(input.project_id || '').trim();
    if (!projectId) return { successBoolean: false, responseString: 'project_id is required.' };
    try {
      const rows = await getProjectsApplicationService().resolveEffectiveLanes(projectId, Boolean(input.include_archived));
      return { successBoolean: true, responseString: JSON.stringify(rows) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Resolve lanes failed: ${ err?.message }` };
    }
  }
}
