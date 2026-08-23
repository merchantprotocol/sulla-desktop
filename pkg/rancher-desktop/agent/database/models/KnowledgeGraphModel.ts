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

export interface NodeAliasRecord {
  alias:      string;
  alias_norm: string;
  node_id:    string;
}

export interface NodeLinkRecord {
  src_id:        string;
  dst_id:        string;
  relation_type: string;
  strength:      number;
  fire_count:    number;
  last_fired_at: string | null;
  confirmed:     boolean;
  created_at:    string;
}

export interface AliasResolutionRecord {
  node_id:   string;
  title:     string;
  node_type: string;
  alias:     string;
  match:     'exact' | 'fuzzy';
  sim:       number;
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

  /** Idempotent #516 bootstrap retained for API compatibility and isolated tests. */
  static async ensureSchema(): Promise<void> {
    await postgresClient.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE EXTENSION IF NOT EXISTS unaccent;
      CREATE OR REPLACE FUNCTION norm_alias(x text) RETURNS text
       LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
      $$ SELECT regexp_replace(lower(unaccent('unaccent', x)), '[^a-z0-9#]+', '', 'g') $$;
      CREATE TABLE IF NOT EXISTS ${ this.NODES_TABLE } (
       id TEXT PRIMARY KEY, node_type TEXT NOT NULL DEFAULT 'entity',
       title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', detail TEXT,
       link_count INTEGER NOT NULL DEFAULT 0, recall_count INTEGER NOT NULL DEFAULT 0,
       last_recalled_at TIMESTAMPTZ, archived BOOLEAN NOT NULL DEFAULT false,
       merged_into TEXT REFERENCES ${ this.NODES_TABLE }(id), source TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || summary)) STORED
      );
      CREATE TABLE IF NOT EXISTS ${ this.ALIASES_TABLE } (
       alias TEXT NOT NULL, alias_norm TEXT NOT NULL,
       node_id TEXT NOT NULL REFERENCES ${ this.NODES_TABLE }(id) ON DELETE CASCADE,
       PRIMARY KEY (alias_norm, node_id)
      );
      CREATE TABLE IF NOT EXISTS ${ this.LINKS_TABLE } (
       src_id TEXT NOT NULL REFERENCES ${ this.NODES_TABLE }(id) ON DELETE CASCADE,
       dst_id TEXT NOT NULL REFERENCES ${ this.NODES_TABLE }(id) ON DELETE CASCADE,
       relation_type TEXT NOT NULL DEFAULT 'related_to',
       strength REAL NOT NULL DEFAULT 0.3, fire_count INTEGER NOT NULL DEFAULT 0,
       last_fired_at TIMESTAMPTZ, confirmed BOOLEAN NOT NULL DEFAULT false,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (src_id, dst_id, relation_type), CHECK (src_id <> dst_id)
      );
      CREATE INDEX IF NOT EXISTS idx_node_aliases_norm ON ${ this.ALIASES_TABLE } (alias_norm);
      CREATE INDEX IF NOT EXISTS idx_node_aliases_trgm ON ${ this.ALIASES_TABLE } USING gin (alias_norm gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_tsv ON ${ this.NODES_TABLE } USING gin (search_tsv);
      CREATE INDEX IF NOT EXISTS idx_node_links_src ON ${ this.LINKS_TABLE } (src_id) INCLUDE (dst_id, relation_type, strength, confirmed, last_fired_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_node_links_dst ON ${ this.LINKS_TABLE } (dst_id) INCLUDE (src_id, relation_type, strength, confirmed, last_fired_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_hub ON ${ this.NODES_TABLE } (link_count DESC) WHERE archived = false;
    `);
  }

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

  static async addAlias(nodeId: string, alias: string): Promise<NodeAliasRecord> {
    const row = await postgresClient.queryOne<NodeAliasRecord>(
      `INSERT INTO ${ this.ALIASES_TABLE } (alias, alias_norm, node_id)
       VALUES ($1, norm_alias($1), $2)
       ON CONFLICT (alias_norm, node_id) DO UPDATE SET alias = EXCLUDED.alias
       RETURNING *`,
      [alias, nodeId],
    );
    if (!row) throw new Error(`Failed to add alias "${ alias }" for node: ${ nodeId }`);
    return row;
  }

  /** Preserve #516's alias-resolution row shape and exact-before-fuzzy order. */
  static async resolveAliases(terms: string[]): Promise<AliasResolutionRecord[]> {
    const clean = Array.from(new Set(terms.map(term => term.trim()).filter(Boolean))).slice(0, 16);
    if (!clean.length) return [];

    return postgresClient.query<AliasResolutionRecord>(
      `WITH input_terms AS (SELECT unnest($1::text[]) AS term),
       normalized_terms AS (
         SELECT term, norm_alias(term) AS term_norm FROM input_terms
         WHERE norm_alias(term) <> ''
       ), exact_matches AS (
         SELECT DISTINCT ON (a.node_id, a.alias_norm)
           a.node_id, n.title, n.node_type, a.alias, 'exact'::text AS match, 1::real AS sim
         FROM normalized_terms t
         JOIN ${ this.ALIASES_TABLE } a ON a.alias_norm = t.term_norm
         JOIN ${ this.NODES_TABLE } n ON n.id = a.node_id
         WHERE n.archived = false AND n.merged_into IS NULL
         ORDER BY a.node_id, a.alias_norm, a.alias
       ), fuzzy_matches AS (
         SELECT DISTINCT ON (a.node_id, a.alias_norm)
           a.node_id, n.title, n.node_type, a.alias, 'fuzzy'::text AS match,
           similarity(a.alias_norm, t.term_norm)::real AS sim
         FROM normalized_terms t
         JOIN ${ this.ALIASES_TABLE } a ON a.alias_norm % t.term_norm
         JOIN ${ this.NODES_TABLE } n ON n.id = a.node_id
         WHERE n.archived = false AND n.merged_into IS NULL
           AND NOT EXISTS (SELECT 1 FROM exact_matches e WHERE e.node_id = a.node_id)
         ORDER BY a.node_id, a.alias_norm, similarity(a.alias_norm, t.term_norm) DESC, a.alias
       )
       SELECT node_id, title, node_type, alias, match, sim
       FROM (SELECT * FROM exact_matches UNION ALL SELECT * FROM fuzzy_matches) matches
       ORDER BY CASE match WHEN 'exact' THEN 0 ELSE 1 END, sim DESC, title ASC`,
      [clean],
    );
  }

  /** Association recall adapter: resolve aliases, then load full canonical nodes. */
  static async resolveAliasNodes(terms: string[]): Promise<KnowledgeNodeRecord[]> {
    const resolved = await this.resolveAliases(terms);
    const ids = Array.from(new Set(resolved.map(row => row.node_id)));
    if (!ids.length) return [];
    const rows = await postgresClient.query<KnowledgeNodeRecord>(
      `SELECT * FROM ${ this.NODES_TABLE }
       WHERE id = ANY($1::text[]) AND archived = false AND merged_into IS NULL`,
      [ids],
    );
    const byId = new Map(rows.map(row => [row.id, row]));
    return ids.map(id => byId.get(id)).filter((row): row is KnowledgeNodeRecord => Boolean(row));
  }

  static async linkNodes(srcId: string, dstId: string, relationType = 'related_to', strength = 0.3): Promise<NodeLinkRecord> {
    return postgresClient.transaction(async(client) => {
      const { rows } = await client.query<NodeLinkRecord>(
        `WITH inserted AS (
           INSERT INTO ${ this.LINKS_TABLE } (src_id, dst_id, relation_type, strength)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (src_id, dst_id, relation_type) DO UPDATE SET strength = EXCLUDED.strength
           RETURNING *, (xmax = 0) AS was_inserted
         ), bumped AS (
           UPDATE ${ this.NODES_TABLE } n SET link_count = link_count + 1, updated_at = now()
           FROM inserted i
           WHERE i.was_inserted AND n.id IN (i.src_id, i.dst_id)
           RETURNING n.id
         )
         SELECT src_id, dst_id, relation_type, strength, fire_count,
                last_fired_at, confirmed, created_at FROM inserted`,
        [srcId, dstId, relationType, strength],
      );
      if (!rows[0]) throw new Error(`Failed to link ${ srcId } -> ${ dstId } (${ relationType })`);
      return rows[0];
    });
  }

  static async reinforceLink(srcId: string, dstId: string, relationType = 'related_to'): Promise<NodeLinkRecord> {
    const row = await postgresClient.queryOne<NodeLinkRecord>(
      `UPDATE ${ this.LINKS_TABLE }
       SET strength = strength + 0.2 * (1 - strength),
           fire_count = fire_count + 1, last_fired_at = now()
       WHERE src_id = $1 AND dst_id = $2 AND relation_type = $3 RETURNING *`,
      [srcId, dstId, relationType],
    );
    if (!row) throw new Error(`No link found to reinforce: ${ srcId } -> ${ dstId } (${ relationType })`);
    return row;
  }

  static async bumpRecalled(ids: string[]): Promise<KnowledgeNodeRecord[]> {
    const uniqueIds = Array.from(new Set(ids.map(id => id.trim()).filter(Boolean)));
    if (!uniqueIds.length) return [];
    return postgresClient.query<KnowledgeNodeRecord>(
      `UPDATE ${ this.NODES_TABLE }
       SET recall_count = recall_count + 1, last_recalled_at = now(), updated_at = now()
       WHERE id = ANY($1::text[]) RETURNING *`,
      [uniqueIds],
    );
  }

  static async archiveNode(id: string): Promise<boolean> {
    const result = await postgresClient.queryWithResult(
      `UPDATE ${ this.NODES_TABLE } SET archived = true, updated_at = now() WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
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
