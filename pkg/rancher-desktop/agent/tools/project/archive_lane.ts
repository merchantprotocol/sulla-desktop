import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import { BaseTool, ToolResponse } from '../base';

export class ArchiveLaneWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      await WorkLaneDefinitionModel.ensureTable();
      const result = await WorkLaneDefinitionModel.archive(
        String(input.id || '').trim(), input.destination_lane_key || undefined, input.actor || 'sulla',
      );
      return { successBoolean: true, responseString: JSON.stringify(result) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Archive lane failed: ${ err?.message }` };
    }
  }
}
