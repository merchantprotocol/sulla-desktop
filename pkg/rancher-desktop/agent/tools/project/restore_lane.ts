import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import { BaseTool, ToolResponse } from '../base';

export class RestoreLaneWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      await WorkLaneDefinitionModel.ensureTable();
      const row = await WorkLaneDefinitionModel.restore(String(input.id || '').trim(), input.actor || 'sulla');
      if (!row) return { successBoolean: false, responseString: `No restorable lane found with id: ${ input.id }` };
      return { successBoolean: true, responseString: JSON.stringify(row) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Restore lane failed: ${ err?.message }` };
    }
  }
}
