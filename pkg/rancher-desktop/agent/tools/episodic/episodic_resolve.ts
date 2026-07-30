import { KnowledgeGraphModel } from '../../database/models/KnowledgeGraphModel';
import { BaseTool, ToolResponse } from '../base';

export class EpisodicResolveWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const terms = Array.isArray(input.terms) ? input.terms.map(String) : [];
    const cleanTerms = terms.map(t => t.trim()).filter(Boolean);

    if (cleanTerms.length === 0) {
      return {
        successBoolean: false,
        responseString: 'Provide at least one non-empty term to resolve.',
      };
    }

    try {
      const rows = await KnowledgeGraphModel.resolveAliases(cleanTerms);

      return {
        successBoolean: true,
        responseString: JSON.stringify(rows, null, 2),
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Failed to resolve episodic aliases: ${ err?.message }`,
      };
    }
  }
}
