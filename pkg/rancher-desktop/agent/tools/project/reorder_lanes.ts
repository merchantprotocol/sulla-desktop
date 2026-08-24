import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import { BaseTool, ToolResponse } from '../base';

export class ReorderLanesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      await WorkLaneDefinitionModel.ensureTable();
      const changed = await WorkLaneDefinitionModel.reorder(
        input.scope, input.ordered_lane_keys, input.project_id || undefined, input.actor || 'sulla',
      );
      return { successBoolean: true, responseString: `${ changed } lane definition(s) reordered.` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Reorder lanes failed: ${ err?.message }` };
    }
  }
}
