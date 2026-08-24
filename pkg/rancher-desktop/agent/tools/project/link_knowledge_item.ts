import { WorkItemKnowledgeModel } from '../../database/models/WorkItemKnowledgeModel';
import { BaseTool, ToolResponse } from '../base';
import { associationInput, formatJson } from '../knowledgeAssociationAdapter';

export class LinkKnowledgeItemWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const link = await WorkItemKnowledgeModel.link(associationInput(input));
      return { successBoolean: true, responseString: formatJson(link) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Link knowledge item failed: ${ err?.message ?? String(err) }` };
    }
  }
}
