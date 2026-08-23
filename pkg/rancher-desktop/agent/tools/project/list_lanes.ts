import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import { BaseTool, ToolResponse } from '../base';

export class ListLanesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      await WorkLaneDefinitionModel.ensureTable();
      const rows = await WorkLaneDefinitionModel.list({
        scope:           input.scope || undefined,
        projectId:       input.project_id || undefined,
        includeArchived: Boolean(input.include_archived),
        includeReset:    Boolean(input.include_reset),
      });
      return { successBoolean: true, responseString: JSON.stringify(rows) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `List lanes failed: ${ err?.message }` };
    }
  }
}
