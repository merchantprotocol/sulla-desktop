import { KnowledgeGraphModel } from '../../database/models/KnowledgeGraphModel';
import { BaseTool, ToolResponse } from '../base';
import { formatJson } from '../knowledgeAssociationAdapter';

export class EpisodicResolveWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const terms = Array.isArray(input.terms) ? input.terms.map(String) : [];
    if (!terms.length) return { successBoolean: false, responseString: 'terms is required.' };
    try {
      const rows = await KnowledgeGraphModel.resolveAliases(terms);
      return { successBoolean: true, responseString: formatJson(rows) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Resolve knowledge nodes failed: ${ err?.message ?? String(err) }` };
    }
  }
}
