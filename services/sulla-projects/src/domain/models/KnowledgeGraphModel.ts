import { postgresClient } from '../../database.js';

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

/** Read-only access to the service-owned Knowledge projection. */
export class KnowledgeGraphModel {
  static readonly NODES_TABLE = 'projects_knowledge_projection';

  static async getNode(id: string): Promise<KnowledgeNodeRecord | null> {
    return postgresClient.queryOne<KnowledgeNodeRecord>(
      `SELECT * FROM ${ this.NODES_TABLE } WHERE id = $1 LIMIT 1`,
      [id],
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

}

