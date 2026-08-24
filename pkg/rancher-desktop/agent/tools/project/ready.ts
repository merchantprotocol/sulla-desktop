import { ProjectReadinessModel } from '../../database/models/ProjectReadinessModel';
import { BaseTool, ToolResponse } from '../base';

export class ProjectReadyWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const frontier = await ProjectReadinessModel.ready({
        projectId: typeof input.project_id === 'string' ? input.project_id : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });
      return { successBoolean: true, responseString: JSON.stringify(frontier, null, 2) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to compute project ready frontier: ${ err?.message ?? String(err) }` };
    }
  }
}
