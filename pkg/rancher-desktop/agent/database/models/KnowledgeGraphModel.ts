import { postgresClient } from '../PostgresClient';

export interface KnowledgeNodeRecord {
  id:               string;
  node_type:        string;
  title:            string;
  summary:          string;
  detail:           string | null;
  link_count:       number;
  recall_count:     number;
  last_recalled_at: string | null;
  archived:         boolean;
  merged_into:      string | null;
  source:           string | null;
  created_at:       string;
  updated_at:       string;
}

export interface KnowledgeSearchOptions {
  query?:           string;
  includeArchived?: boolean;
  limit?:           number;
}

export interface UpsertKnowledgeNodeInput {
  id:           string;
  node_type?:   string;
  title:        string;
  summary?:     string;
  detail?:      string | null;
  source?:      string | null;
  archived?:    boolean;
  merged_into?: string | null;
}

/**
 * Canonical model for migration 0029. This restores the model shipped in
 * #523 after the subconscious-agent prune removed its runtime surface while
 * retaining the schema. It remains a plain DB model; no agent middleware is
 * restored here.
 */
export class KnowledgeGraphModel {
  static readonly NODES_TABLE = 'knowledge_nodes';
  static readonly ALIASES_TABLE = 'node_aliases';
  static readonly LINKS_TABLE = 'node_links';

  static async getNode(id: string, includeArchived = false): Promise<KnowledgeNodeRecord | null> {
    return postgresClient.queryOne<KnowledgeNodeRecord>(
      `SELECT * FROM ${ this.NODES_TABLE }
       WHERE id = $1 AND ($2::boolean OR archived = false)
       LIMIT 1`,
      [id, includeArchived],
    );
  }

  static async resolveCanonicalNode(id: string, includeArchived = false): Promise<KnowledgeNodeRecord | null> {
    return postgresClient.queryOne<KnowledgeNodeRecord>(
      `WITH RECURSIVE chain AS (
         SELECT n.*, 0 AS depth, ARRAY[n.id] AS path
         FROM ${ this.NODES_TABLE } n WHERE n.id = $1
         UNION ALL
         SELECT next.*, chain.depth + 1, chain.path || next.id
         FROM chain
         JOIN ${ this.NODES_TABLE } next ON next.id = chain.merged_into
         WHERE chain.merged_into IS NOT NULL
           AND chain.depth < 32
           AND NOT next.id = ANY(chain.path)
       )
       SELECT id, node_type, title, summary, detail, link_count, recall_count,
              last_recalled_at, archived, merged_into, source, created_at, updated_at
       FROM chain
       WHERE merged_into IS NULL AND ($2::boolean OR archived = false)
       ORDER BY depth DESC LIMIT 1`,
      [id, includeArchived],
    );
  }

  static async searchNodes(opts: KnowledgeSearchOptions = {}): Promise<KnowledgeNodeRecord[]> {
    const query = (opts.query ?? '').trim();
    const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));

    return postgresClient.query<KnowledgeNodeRecord>(
      `SELECT n.*
       FROM ${ this.NODES_TABLE } n
       WHERE ($1::boolean OR n.archived = false)
         AND n.merged_into IS NULL
         AND (
           $2 = '' OR n.search_tsv @@ websearch_to_tsquery('english', $2)
           OR n.title ILIKE '%' || $2 || '%'
           OR n.summary ILIKE '%' || $2 || '%'
         )
       ORDER BY
         CASE WHEN $2 <> '' AND n.search_tsv @@ websearch_to_tsquery('english', $2) THEN 0 ELSE 1 END,
         n.updated_at DESC, n.title ASC
       LIMIT $3`,
      [opts.includeArchived ?? false, query, limit],
    );
  }

  static async upsertNode(input: UpsertKnowledgeNodeInput): Promise<KnowledgeNodeRecord> {
    const row = await postgresClient.queryOne<KnowledgeNodeRecord>(
      `INSERT INTO ${ this.NODES_TABLE }
         (id, node_type, title, summary, detail, source, archived, merged_into)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         node_type = EXCLUDED.node_type, title = EXCLUDED.title,
         summary = EXCLUDED.summary, detail = EXCLUDED.detail,
         source = EXCLUDED.source, archived = EXCLUDED.archived,
         merged_into = EXCLUDED.merged_into, updated_at = now()
       RETURNING *`,
      [input.id, input.node_type ?? 'entity', input.title, input.summary ?? '',
        input.detail ?? null, input.source ?? null, input.archived ?? false,
        input.merged_into ?? null],
    );
    if (!row) throw new Error(`Failed to upsert knowledge node: ${ input.id }`);
    return row;
  }

  static async resolveAliases(terms: string[]): Promise<KnowledgeNodeRecord[]> {
    const clean = Array.from(new Set(terms.map(term => term.trim()).filter(Boolean))).slice(0, 16);
    if (!clean.length) return [];

    return postgresClient.query<KnowledgeNodeRecord>(
      `WITH input_terms AS (SELECT unnest($1::text[]) AS term),
       input AS (SELECT norm_alias(term) AS term_norm FROM input_terms),
       matched AS (
         SELECT DISTINCT a.node_id
         FROM input i JOIN ${ this.ALIASES_TABLE } a
           ON a.alias_norm = i.term_norm OR a.alias_norm % i.term_norm
       )
       SELECT n.* FROM matched m JOIN ${ this.NODES_TABLE } n ON n.id = m.node_id
       WHERE n.archived = false AND n.merged_into IS NULL
       ORDER BY n.link_count DESC, n.title ASC`,
      [clean],
    );
  }

  /** Merge graph and work-item references atomically onto one canonical node. */
  static async mergeNode(sourceId: string, canonicalId: string): Promise<KnowledgeNodeRecord> {
    if (sourceId === canonicalId) throw new Error('Cannot merge a knowledge node into itself.');

    return postgresClient.transaction(async(client) => {
      const { rows: nodes } = await client.query<KnowledgeNodeRecord>(
        `SELECT * FROM ${ this.NODES_TABLE } WHERE id = ANY($1::text[]) FOR UPDATE`,
        [[sourceId, canonicalId]],
      );
      if (nodes.length !== 2) throw new Error('Both source and canonical knowledge nodes must exist.');
      const canonical = nodes.find(node => node.id === canonicalId);
      if (!canonical || canonical.archived || canonical.merged_into) {
        throw new Error('Merge target must be an active canonical knowledge node.');
      }

      await client.query(
        `UPDATE work_item_knowledge_links l
         SET knowledge_node_id = $2, updated_at = now()
         WHERE l.knowledge_node_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM work_item_knowledge_links existing
             WHERE existing.knowledge_node_id = $2
               AND existing.relation_type = l.relation_type
               AND existing.archived = l.archived
               AND existing.project_id IS NOT DISTINCT FROM l.project_id
               AND existing.epic_id IS NOT DISTINCT FROM l.epic_id
               AND existing.task_id IS NOT DISTINCT FROM l.task_id
           )`,
        [sourceId, canonicalId],
      );
      await client.query(
        `UPDATE work_item_knowledge_links SET archived = true, updated_at = now()
         WHERE knowledge_node_id = $1`,
        [sourceId],
      );
      await client.query(
        `INSERT INTO ${ this.ALIASES_TABLE } (alias, alias_norm, node_id)
         SELECT alias, alias_norm, $2 FROM ${ this.ALIASES_TABLE } WHERE node_id = $1
         ON CONFLICT (alias_norm, node_id) DO UPDATE SET alias = EXCLUDED.alias`,
        [sourceId, canonicalId],
      );
      await client.query(
        `UPDATE ${ this.NODES_TABLE }
         SET archived = true, merged_into = $2, updated_at = now()
         WHERE id = $1`,
        [sourceId, canonicalId],
      );

      return canonical;
    });
  }
}
