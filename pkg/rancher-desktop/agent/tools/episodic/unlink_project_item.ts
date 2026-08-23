import { WorkItemKnowledgeModel } from '../../database/models/WorkItemKnowledgeModel';
import { BaseTool, ToolResponse } from '../base';
import { associationInput } from '../knowledgeAssociationAdapter';

export class UnlinkProjectItemWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const removed = await WorkItemKnowledgeModel.unlink(associationInput(input));
      return {
        successBoolean: true,
        responseString: removed ? 'Direct project association archived.' : 'No matching active direct association.',
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Unlink project item failed: ${ err?.message ?? String(err) }` };
    }
  }
}
