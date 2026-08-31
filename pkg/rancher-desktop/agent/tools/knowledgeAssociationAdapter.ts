import type { KnowledgeWorkItemKind } from '../database/models/WorkItemKnowledgeModel';

export function parseItem(input: any): { kind: KnowledgeWorkItemKind; id: string } {
  const kind = String(input.item_kind ?? input.itemKind ?? '').trim().toLowerCase() as KnowledgeWorkItemKind;
  const id = String(input.item_id ?? input.itemId ?? '').trim();
  if (!['project', 'epic', 'task'].includes(kind)) {
    throw new Error('item_kind must be project, epic, or task.');
  }
  if (!id) throw new Error('item_id is required.');
  return { kind, id };
}

export function parseNodeId(input: any): string {
  const id = String(input.knowledge_node_id ?? input.knowledgeNodeId ?? '').trim();
  if (!id) throw new Error('knowledge_node_id is required.');
  return id;
}

export function associationInput(input: any) {
  const item = parseItem(input);
  return {
    itemKind:         item.kind,
    itemId:           item.id,
    knowledgeNodeId: parseNodeId(input),
    relationType:    input.relation_type ?? input.relationType,
    note:            input.note ?? null,
    source:          input.source ?? 'tool',
    actor:           input.actor ?? null,
  };
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
