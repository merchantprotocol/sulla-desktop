import { KnowledgeGraphModel, type KnowledgeNodeRecord } from '../../database/models/KnowledgeGraphModel';
import { WorkItemKnowledgeModel, type KnowledgeWorkItemKind } from '../../database/models/WorkItemKnowledgeModel';
import { BaseTool, ToolResponse } from '../base';
import { formatJson } from '../knowledgeAssociationAdapter';

function scope(input: any): { kind: KnowledgeWorkItemKind; id: string } | null {
  const candidates = [
    ['task', input.task_id],
    ['epic', input.epic_id],
    ['project', input.project_id],
  ].filter(([, id]) => typeof id === 'string' && id.trim());
  if (candidates.length > 1) throw new Error('Provide only one of project_id, epic_id, or task_id.');
  if (!candidates[0]) return null;
  return { kind: candidates[0][0] as KnowledgeWorkItemKind, id: String(candidates[0][1]).trim() };
}

export class EpisodicRecallWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 20)));
      const workScope = scope(input);
      const scoped = workScope
        ? await WorkItemKnowledgeModel.listForItem(workScope.kind, workScope.id, {
          includeInherited: Boolean(input.include_inherited ?? true),
          limit,
        })
        : [];
      const query = String(input.query ?? input.query_text ?? '').trim();
      const terms = Array.isArray(input.terms) ? input.terms.map(String) : [];
      const fallback = terms.length
        ? await KnowledgeGraphModel.resolveAliasNodes(terms)
        : await KnowledgeGraphModel.searchNodes({ query, limit });

      const seen = new Set<string>();
      const rows: (KnowledgeNodeRecord & { recall_scope: string; associated_at?: string })[] = [];
      for (const linked of scoped) {
        if (seen.has(linked.node_id)) continue;
        seen.add(linked.node_id);
        rows.push({
          id:               linked.node_id,
          node_type:        linked.node_type,
          title:            linked.title,
          summary:          linked.summary,
          detail:           linked.detail,
          link_count:       0,
          recall_count:     0,
          last_recalled_at: null,
          archived:         linked.node_archived,
          merged_into:      null,
          source:           linked.node_source,
          created_at:       linked.created_at,
          updated_at:       linked.updated_at,
          recall_scope:     linked.scope,
          associated_at:    `${ linked.linked_item_kind }:${ linked.linked_item_id }`,
        });
      }
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
