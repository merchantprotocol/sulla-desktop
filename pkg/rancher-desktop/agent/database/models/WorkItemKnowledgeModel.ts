import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

import type { KnowledgeNodeRecord } from './KnowledgeGraphModel';
import type { PoolClient } from 'pg';

export type KnowledgeWorkItemKind = 'project' | 'epic' | 'task';
export type KnowledgeLinkScope = 'direct' | 'inherited';

export interface KnowledgeLinkInput {
  itemKind:        KnowledgeWorkItemKind;
  itemId:          string;
  knowledgeNodeId: string;
  relationType?:   string;
  note?:           string | null;
  source?:         string | null;
  actor?:          string | null;
}

export interface KnowledgeLinkRecord {
  id:                string;
  knowledge_node_id: string;
  project_id:        string | null;
  epic_id:           string | null;
  task_id:           string | null;
  relation_type:     string;
  note:              string | null;
  source:            string | null;
  created_by:        string | null;
  updated_by:        string | null;
  created_at:        string;
  updated_at:        string;
  archived:          boolean;
}

export interface LinkedKnowledgeRecord extends KnowledgeLinkRecord {
  node_id:           string;
  node_type:         string;
  title:             string;
  summary:           string;
  detail:            string | null;
  node_source:       string | null;
  node_archived:     boolean;
  scope:             KnowledgeLinkScope;
  linked_item_kind:  KnowledgeWorkItemKind;
  linked_item_id:    string;
  linked_item_title: string;
}

export interface LinkedWorkItemRecord extends KnowledgeLinkRecord {
  item_kind:           KnowledgeWorkItemKind;
  item_id:             string;
  item_title:          string;
  item_status:         string;
  item_archived:       boolean;
  project_id_resolved: string;
  project_title:       string;
  epic_id_resolved:    string | null;
  epic_title:          string | null;
}

export interface ListLinkedKnowledgeOptions {
  includeInherited?: boolean;
  includeArchived?:  boolean;
  relationType?:     string;
  limit?:            number;
}

export interface ListLinkedWorkOptions {
  includeArchived?: boolean;
  relationType?:    string;
  limit?:           number;
}

const TARGETS: Record<KnowledgeWorkItemKind, { table: string; column: string }> = {
  project: { table: 'work_projects', column: 'project_id' },
  epic:    { table: 'work_epics', column: 'epic_id' },
  task:    { table: 'work_tasks', column: 'task_id' },
};

function cleanRelation(value: string | undefined): string {
  const relation = (value ?? 'related_to').trim();
  if (!relation || relation.length > 80 || !/^[a-z][a-z0-9_-]*$/i.test(relation)) {
    throw new Error('relation_type must be 1-80 letters, numbers, underscores, or dashes.');
  }
  return relation;
}

function boundedLimit(value: number | undefined, fallback = 50): number {
  return Math.max(1, Math.min(200, Math.floor(value ?? fallback)));
}

export class WorkItemKnowledgeModel {
  static readonly TABLE = 'work_item_knowledge_links';

  private static target(kind: KnowledgeWorkItemKind) {
    const target = TARGETS[kind];
    if (!target) throw new Error(`Invalid item_kind: ${ kind }`);
    return target;
  }

  private static async canonicalNode(client: PoolClient, id: string): Promise<KnowledgeNodeRecord> {
    const { rows } = await client.query<KnowledgeNodeRecord>(
      `WITH RECURSIVE chain AS (
         SELECT n.*, 0 depth, ARRAY[n.id] path FROM knowledge_nodes n WHERE n.id = $1
         UNION ALL
         SELECT next.*, chain.depth + 1, chain.path || next.id
         FROM chain JOIN knowledge_nodes next ON next.id = chain.merged_into
         WHERE chain.merged_into IS NOT NULL AND chain.depth < 32
           AND NOT next.id = ANY(chain.path)
       )
       SELECT id, node_type, title, summary, detail, link_count, recall_count,
              last_recalled_at, archived, merged_into, source, created_at, updated_at
       FROM chain WHERE merged_into IS NULL ORDER BY depth DESC LIMIT 1`,
      [id],
    );
    if (!rows[0]) throw new Error(`Knowledge node not found: ${ id }`);
    if (rows[0].archived) throw new Error(`Knowledge node is archived: ${ rows[0].id }`);
    return rows[0];
  }

  private static async assertItem(kind: KnowledgeWorkItemKind, id: string, includeArchived: boolean): Promise<void> {
    const target = this.target(kind);
    const row = await postgresClient.queryOne<{ archived: boolean }>(
      `SELECT archived FROM ${ target.table } WHERE id = $1`,
      [id],
    );
    if (!row) throw new Error(`${ kind } not found: ${ id }`);
    if (row.archived && !includeArchived) throw new Error(`${ kind } is archived: ${ id }`);
  }

  static async link(input: KnowledgeLinkInput): Promise<KnowledgeLinkRecord> {
    const target = this.target(input.itemKind);
    const relation = cleanRelation(input.relationType);

    return postgresClient.transaction(async(client) => {
      const node = await this.canonicalNode(client, input.knowledgeNodeId);
      const { rows: items } = await client.query(
        `SELECT id, archived FROM ${ target.table } WHERE id = $1 FOR SHARE`,
        [input.itemId],
      );
      if (!items[0]) throw new Error(`${ input.itemKind } not found: ${ input.itemId }`);
      if (items[0].archived) throw new Error(`${ input.itemKind } is archived: ${ input.itemId }`);

      const lockKey = `${ node.id }:${ target.column }:${ input.itemId }:${ relation }`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

      const { rows: existing } = await client.query<KnowledgeLinkRecord>(
        `SELECT * FROM ${ this.TABLE }
         WHERE knowledge_node_id = $1 AND ${ target.column } = $2 AND relation_type = $3
         ORDER BY archived ASC, updated_at DESC LIMIT 1 FOR UPDATE`,
        [node.id, input.itemId, relation],
      );
      if (existing[0]) {
        const { rows } = await client.query<KnowledgeLinkRecord>(
          `UPDATE ${ this.TABLE }
           SET archived = false, note = $2, source = $3,
               created_by = COALESCE(created_by, $4), updated_by = $4, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [existing[0].id, input.note ?? existing[0].note, input.source ?? existing[0].source,
            input.actor ?? existing[0].created_by],
        );
        return rows[0];
      }

      const columns = ['id', 'knowledge_node_id', target.column, 'relation_type', 'note', 'source', 'created_by', 'updated_by'];
      const { rows } = await client.query<KnowledgeLinkRecord>(
        `INSERT INTO ${ this.TABLE } (${ columns.join(', ') })
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
        [randomUUID(), node.id, input.itemId, relation, input.note ?? null,
          input.source ?? 'agent', input.actor ?? null],
      );
      return rows[0];
    });
  }

  static async unlink(input: KnowledgeLinkInput): Promise<boolean> {
    const target = this.target(input.itemKind);
    const relation = cleanRelation(input.relationType);
    // Unlink is a mutation and must fail closed just like link/list: a stale,
    // archived, or fabricated work target must never turn into a silent no-op.
    await this.assertItem(input.itemKind, input.itemId, false);
    const node = await postgresClient.queryOne<{ id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, merged_into, ARRAY[id] path FROM knowledge_nodes WHERE id = $1
         UNION ALL SELECT n.id, n.merged_into, chain.path || n.id
         FROM chain JOIN knowledge_nodes n ON n.id = chain.merged_into
         WHERE NOT n.id = ANY(chain.path)
       ) SELECT id FROM chain WHERE merged_into IS NULL LIMIT 1`,
      [input.knowledgeNodeId],
    );
    if (!node) throw new Error(`Knowledge node not found: ${ input.knowledgeNodeId }`);
    const result = await postgresClient.queryWithResult(
      `UPDATE ${ this.TABLE }
       SET archived = true, updated_at = now(),
           updated_by = COALESCE($4, updated_by), source = COALESCE($5, source)
       WHERE knowledge_node_id = $1 AND ${ target.column } = $2
         AND relation_type = $3 AND archived = false`,
      [node.id, input.itemId, relation, input.actor ?? null, input.source ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  static async listForItem(
    kind: KnowledgeWorkItemKind,
    itemId: string,
    opts: ListLinkedKnowledgeOptions = {},
  ): Promise<LinkedKnowledgeRecord[]> {
    this.target(kind);
    const limit = boundedLimit(opts.limit);
    const relation = opts.relationType?.trim() || null;
    await this.assertItem(kind, itemId, opts.includeArchived ?? false);

    const scopes = kind === 'project'
      ? `SELECT p.id, 'project'::text kind, p.title, p.archived, 0 ord FROM work_projects p WHERE p.id = $1`
      : kind === 'epic'
        ? `SELECT e.id, 'epic'::text kind, e.title, e.archived, 0 ord FROM work_epics e WHERE e.id = $1
           UNION ALL SELECT p.id, 'project', p.title, p.archived, 1 FROM work_epics e JOIN work_projects p ON p.id = e.project_id WHERE e.id = $1`
        : `SELECT t.id, 'task'::text kind, t.title, t.archived, 0 ord FROM work_tasks t WHERE t.id = $1
           UNION ALL SELECT e.id, 'epic', e.title, e.archived, 1 FROM work_tasks t JOIN work_epics e ON e.id = t.epic_id WHERE t.id = $1
           UNION ALL SELECT p.id, 'project', p.title, p.archived, 2 FROM work_tasks t JOIN work_projects p ON p.id = t.project_id WHERE t.id = $1`;

    return postgresClient.query<LinkedKnowledgeRecord>(
      `WITH scopes AS (${ scopes }), links AS (
         SELECT l.*, s.kind linked_item_kind, s.id linked_item_id,
                s.title linked_item_title, s.ord
         FROM scopes s JOIN ${ this.TABLE } l ON
           (s.kind = 'project' AND l.project_id = s.id) OR
           (s.kind = 'epic' AND l.epic_id = s.id) OR
           (s.kind = 'task' AND l.task_id = s.id)
         WHERE ($2::boolean OR s.ord = 0) AND ($3::boolean OR s.archived = false)
       )
       SELECT l.*, n.id node_id, n.node_type, n.title, n.summary, n.detail,
              n.source node_source, n.archived node_archived,
              CASE WHEN l.ord = 0 THEN 'direct' ELSE 'inherited' END scope
       FROM links l JOIN knowledge_nodes n ON n.id = l.knowledge_node_id
       WHERE ($3::boolean OR (l.archived = false AND n.archived = false))
         AND ($4::text IS NULL OR l.relation_type = $4)
       ORDER BY l.ord ASC, l.updated_at DESC, n.title ASC
       LIMIT $5`,
      [itemId, opts.includeInherited ?? false, opts.includeArchived ?? false, relation, limit],
    );
  }

  static async listForNode(
    knowledgeNodeId: string,
    opts: ListLinkedWorkOptions = {},
  ): Promise<LinkedWorkItemRecord[]> {
    const limit = boundedLimit(opts.limit);
    const relation = opts.relationType?.trim() || null;
    const node = await postgresClient.queryOne<{ id: string; archived: boolean }>(
      `WITH RECURSIVE chain AS (
         SELECT id, merged_into, archived, ARRAY[id] path FROM knowledge_nodes WHERE id = $1
         UNION ALL SELECT n.id, n.merged_into, n.archived, chain.path || n.id
         FROM chain JOIN knowledge_nodes n ON n.id = chain.merged_into
         WHERE NOT n.id = ANY(chain.path)
       ) SELECT id, archived FROM chain WHERE merged_into IS NULL LIMIT 1`,
      [knowledgeNodeId],
    );
    if (!node) throw new Error(`Knowledge node not found: ${ knowledgeNodeId }`);
    if (node.archived && !opts.includeArchived) throw new Error(`Knowledge node is archived: ${ node.id }`);

    return postgresClient.query<LinkedWorkItemRecord>(
      `WITH RECURSIVE chain AS (
         SELECT id, merged_into, ARRAY[id] path FROM knowledge_nodes WHERE id = $1
         UNION ALL SELECT n.id, n.merged_into, chain.path || n.id
         FROM chain JOIN knowledge_nodes n ON n.id = chain.merged_into
         WHERE NOT n.id = ANY(chain.path)
       ), canonical AS (SELECT id FROM chain WHERE merged_into IS NULL LIMIT 1), items AS (
         SELECT l.*, 'project'::text item_kind, p.id item_id, p.title item_title,
                p.status item_status, p.archived item_archived,
                p.id project_id_resolved, p.title project_title,
                NULL::text epic_id_resolved, NULL::text epic_title
         FROM ${ this.TABLE } l JOIN work_projects p ON p.id = l.project_id
         UNION ALL
         SELECT l.*, 'epic', e.id, e.title, e.status, e.archived,
                p.id, p.title, e.id, e.title
         FROM ${ this.TABLE } l JOIN work_epics e ON e.id = l.epic_id
         JOIN work_projects p ON p.id = e.project_id
         UNION ALL
         SELECT l.*, 'task', t.id, t.title, t.status, t.archived,
                p.id, p.title, e.id, e.title
         FROM ${ this.TABLE } l JOIN work_tasks t ON t.id = l.task_id
         JOIN work_projects p ON p.id = t.project_id
         LEFT JOIN work_epics e ON e.id = t.epic_id
       )
       SELECT items.* FROM items, canonical
       WHERE items.knowledge_node_id = canonical.id
         AND ($2::boolean OR (items.archived = false AND items.item_archived = false))
         AND ($3::text IS NULL OR items.relation_type = $3)
       ORDER BY CASE item_kind WHEN 'project' THEN 0 WHEN 'epic' THEN 1 ELSE 2 END,
                items.updated_at DESC, items.item_title ASC
       LIMIT $4`,
      [knowledgeNodeId, opts.includeArchived ?? false, relation, limit],
    );
  }

  static async countForItems(kind: KnowledgeWorkItemKind, ids: string[]): Promise<Record<string, number>> {
    const target = this.target(kind);
    const uniqueIds = Array.from(new Set(ids.filter(Boolean))).slice(0, 1000);
    if (!uniqueIds.length) return {};
    const rows = await postgresClient.query<{ item_id: string; count: string }>(
      `SELECT ${ target.column } item_id, count(*)::text count
       FROM ${ this.TABLE } l JOIN knowledge_nodes n ON n.id = l.knowledge_node_id
       WHERE ${ target.column } = ANY($1::text[]) AND l.archived = false AND n.archived = false
       GROUP BY ${ target.column }`,
      [uniqueIds],
    );
    return Object.fromEntries(rows.map(row => [row.item_id, Number(row.count)]));
  }
}
