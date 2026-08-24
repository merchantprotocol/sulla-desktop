import { WorkItemKnowledgeModel } from '../../database/models/WorkItemKnowledgeModel';
import { BaseTool, ToolResponse } from '../base';
import { associationInput } from '../knowledgeAssociationAdapter';

export class UnlinkKnowledgeItemWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const removed = await WorkItemKnowledgeModel.unlink(associationInput(input));
      return {
        successBoolean: true,
        responseString: removed ? 'Direct knowledge association archived.' : 'No matching active direct association.',
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Unlink knowledge item failed: ${ err?.message ?? String(err) }` };
    }
  }
}
