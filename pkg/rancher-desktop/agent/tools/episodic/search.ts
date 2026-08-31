import { KnowledgeGraphModel } from '../../database/models/KnowledgeGraphModel';
import { BaseTool, ToolResponse } from '../base';
import { formatJson } from '../knowledgeAssociationAdapter';

export class EpisodicSearchWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const rows = await KnowledgeGraphModel.searchNodes({
        query:           input.query,
        includeArchived: Boolean(input.include_archived ?? false),
        limit:           input.limit,
      });
      return { successBoolean: true, responseString: formatJson(rows) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Search knowledge nodes failed: ${ err?.message ?? String(err) }` };
    }
  }
}
