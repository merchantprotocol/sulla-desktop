import { WorkItemKnowledgeModel } from '../../database/models/WorkItemKnowledgeModel';
import { BaseTool, ToolResponse } from '../base';
import { formatJson, parseItem } from '../knowledgeAssociationAdapter';

export class ListLinkedKnowledgeWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const item = parseItem(input);
      const rows = await WorkItemKnowledgeModel.listForItem(item.kind, item.id, {
        includeInherited: Boolean(input.include_inherited ?? true),
        includeArchived:  Boolean(input.include_archived ?? false),
        relationType:     input.relation_type,
        limit:            input.limit,
      });
      return { successBoolean: true, responseString: formatJson(rows) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `List linked knowledge failed: ${ err?.message ?? String(err) }` };
    }
  }
}
