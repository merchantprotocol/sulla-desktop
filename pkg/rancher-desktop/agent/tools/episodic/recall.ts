import { KnowledgeGraphModel, type KnowledgeNodeRecord } from '../../database/models/KnowledgeGraphModel';
import { BaseTool, ToolResponse } from '../base';
import { formatJson } from '../knowledgeAssociationAdapter';


export class EpisodicRecallWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 20)));
      const query = String(input.query ?? input.query_text ?? '').trim();
      const terms = Array.isArray(input.terms) ? input.terms.map(String) : [];
      const fallback = terms.length
        ? await KnowledgeGraphModel.resolveAliasNodes(terms)
        : await KnowledgeGraphModel.searchNodes({ query, limit });

      const seen = new Set<string>();
      const rows: (KnowledgeNodeRecord & { recall_scope: string; associated_at?: string })[] = [];
      for (const node of fallback) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        rows.push({ ...node, recall_scope: 'fallback' });
      }

      return { successBoolean: true, responseString: formatJson(rows.slice(0, limit)) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Recall knowledge failed: ${ err?.message ?? String(err) }` };
    }
  }
}
