import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import { BaseTool, ToolResponse } from '../base';

export class ResolveLanesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const projectId = String(input.project_id || '').trim();
    if (!projectId) return { successBoolean: false, responseString: 'project_id is required.' };
    try {
      await WorkLaneDefinitionModel.ensureTable();
      const rows = await WorkLaneDefinitionModel.resolveEffective(projectId, Boolean(input.include_archived));
      return { successBoolean: true, responseString: JSON.stringify(rows) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Resolve lanes failed: ${ err?.message }` };
    }
  }
}
