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

export interface AliasResolutionRecord {
  node_id:   string;
  title:     string;
  node_type: string;
  alias:     string;
  match:     'exact' | 'fuzzy';
  sim:       number;
}

export interface SpreadActivationRecord extends KnowledgeNodeRecord {
  /** Accumulated activation along the strongest path from any anchor (anchors = 1.0). */
  activation: number;
  /** Fewest hops from an anchor (0 = the anchor node itself). */
  hop:        number;
}

export interface SpreadActivationOptions {
  /** Max hops to spread from the anchors. Default 2 (the epic's ≤2-hop rule). */
  maxHops?:   number;
  /** Per-hop activation decay multiplier, on top of edge strength. Default 0.5. */
  decay?:     number;
  /** Drop edges weaker than this while spreading (bounds hub fan-out). Default 0. */
  minEdge?:   number;
  /** Max nodes returned, highest activation first. Default 12. */
  limit?:     number;
}

export interface EpisodicRecallOptions extends SpreadActivationOptions {
  /** Query-level safety bound only. This must not be used as an agent wall-clock timeout. */
  statementTimeoutMs?: number;
}

export class KnowledgeGraphModel {
  static readonly NODES_TABLE = 'knowledge_nodes';
  static readonly ALIASES_TABLE = 'node_aliases';
  static readonly LINKS_TABLE = 'node_links';

  static async ensureSchema(): Promise<void> {
    await postgresClient.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE EXTENSION IF NOT EXISTS unaccent;
      CREATE OR REPLACE FUNCTION norm_alias(x text) RETURNS text
       LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
      $$ SELECT regexp_replace(lower(unaccent('unaccent', x)), '[^a-z0-9#]+', '', 'g') $$;

      CREATE TABLE IF NOT EXISTS ${ KnowledgeGraphModel.NODES_TABLE } (
       id TEXT PRIMARY KEY,
       node_type TEXT NOT NULL DEFAULT 'entity',
       title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', detail TEXT,
       link_count INTEGER NOT NULL DEFAULT 0, recall_count INTEGER NOT NULL DEFAULT 0,
       last_recalled_at TIMESTAMPTZ, archived BOOLEAN NOT NULL DEFAULT false,
       merged_into TEXT REFERENCES ${ KnowledgeGraphModel.NODES_TABLE }(id), source TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || summary)) STORED
      );
      CREATE TABLE IF NOT EXISTS ${ KnowledgeGraphModel.ALIASES_TABLE } (
       alias TEXT NOT NULL, alias_norm TEXT NOT NULL,
       node_id TEXT NOT NULL REFERENCES ${ KnowledgeGraphModel.NODES_TABLE }(id) ON DELETE CASCADE,
       PRIMARY KEY (alias_norm, node_id)
      );
      CREATE TABLE IF NOT EXISTS ${ KnowledgeGraphModel.LINKS_TABLE } (
       src_id TEXT NOT NULL REFERENCES ${ KnowledgeGraphModel.NODES_TABLE }(id) ON DELETE CASCADE,
       dst_id TEXT NOT NULL REFERENCES ${ KnowledgeGraphModel.NODES_TABLE }(id) ON DELETE CASCADE,
       relation_type TEXT NOT NULL DEFAULT 'related_to',
       strength REAL NOT NULL DEFAULT 0.3, fire_count INTEGER NOT NULL DEFAULT 0,
       last_fired_at TIMESTAMPTZ, confirmed BOOLEAN NOT NULL DEFAULT false,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (src_id, dst_id, relation_type), CHECK (src_id <> dst_id)
      );
      CREATE INDEX IF NOT EXISTS idx_node_aliases_norm ON ${ KnowledgeGraphModel.ALIASES_TABLE } (alias_norm);
      CREATE INDEX IF NOT EXISTS idx_node_aliases_trgm ON ${ KnowledgeGraphModel.ALIASES_TABLE } USING gin (alias_norm gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_tsv ON ${ KnowledgeGraphModel.NODES_TABLE } USING gin (search_tsv);
      CREATE INDEX IF NOT EXISTS idx_node_links_src ON ${ KnowledgeGraphModel.LINKS_TABLE } (src_id) INCLUDE (dst_id, relation_type, strength, confirmed, last_fired_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_node_links_dst ON ${ KnowledgeGraphModel.LINKS_TABLE } (dst_id) INCLUDE (src_id, relation_type, strength, confirmed, last_fired_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_hub ON ${ KnowledgeGraphModel.NODES_TABLE } (link_count DESC) WHERE archived = false;
    `);
  }

  static async resolveAliases(terms: string[]): Promise<AliasResolutionRecord[]> {
    const cleanTerms = terms.map(t => t.trim()).filter(Boolean);
    if (cleanTerms.length === 0) return [];

    return postgresClient.query<AliasResolutionRecord>(
      `WITH input_terms AS (
         SELECT unnest($1::text[]) AS term
       ),
       normalized_terms AS (
         SELECT term, norm_alias(term) AS term_norm
         FROM input_terms
         WHERE norm_alias(term) <> ''
       ),
       exact_matches AS (
         SELECT DISTINCT ON (a.node_id, a.alias_norm)
           a.node_id, n.title, n.node_type, a.alias, 'exact'::text AS match, 1::real AS sim
         FROM normalized_terms t
         JOIN ${ KnowledgeGraphModel.ALIASES_TABLE } a ON a.alias_norm = t.term_norm
         JOIN ${ KnowledgeGraphModel.NODES_TABLE } n ON n.id = a.node_id
         WHERE n.archived = false AND n.merged_into IS NULL
         ORDER BY a.node_id, a.alias_norm, a.alias
       ),
       fuzzy_matches AS (
         SELECT DISTINCT ON (a.node_id, a.alias_norm)
           a.node_id, n.title, n.node_type, a.alias, 'fuzzy'::text AS match,
           similarity(a.alias_norm, t.term_norm)::real AS sim
         FROM normalized_terms t
         JOIN ${ KnowledgeGraphModel.ALIASES_TABLE } a ON a.alias_norm % t.term_norm
         JOIN ${ KnowledgeGraphModel.NODES_TABLE } n ON n.id = a.node_id
         WHERE n.archived = false
           AND n.merged_into IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM exact_matches e WHERE e.node_id = a.node_id
           )
         ORDER BY a.node_id, a.alias_norm, similarity(a.alias_norm, t.term_norm) DESC, a.alias
       )
       SELECT node_id, title, node_type, alias, match, sim
       FROM (
         SELECT * FROM exact_matches
         UNION ALL
         SELECT * FROM fuzzy_matches
       ) matches
       ORDER BY CASE match WHEN 'exact' THEN 0 ELSE 1 END, sim DESC, title ASC`,
      [cleanTerms],
    );
  }

  /**
   * Spreading activation — the core of the Recall agent (#517).
   *
   * You don't search memory, you land on it: given anchor node ids (resolved
   * from the utterance's terms via `resolveAliases`), walk the weighted link
   * graph outward ≤`maxHops` and return the activated neighborhood ranked by
   * accumulated activation. This is ONE SQL statement — no agent loop — so it
   * converges structurally instead of relying on an iteration cap.
   *
   * Activation of a reached node = anchor(1.0) × Π(edge.strength × decay) along
   * the strongest acyclic path. Anchors come back at hop 0, activation 1.0.
   * Links are treated as undirected for spread (association flows both ways)
   * even though they're stored directed. `minEdge` bounds hub fan-out; the
   * final `limit` keeps only the hottest nodes.
   */
  static async spreadActivation(
    anchorIds: string[],
    opts: SpreadActivationOptions = {},
  ): Promise<SpreadActivationRecord[]> {
    const ids = Array.from(new Set(anchorIds.map(id => id.trim()).filter(Boolean)));
    if (ids.length === 0) return [];

    const maxHops = Math.max(1, Math.floor(opts.maxHops ?? 2));
    const decay   = opts.decay   ?? 0.5;
    const minEdge = opts.minEdge ?? 0;
    const limit   = Math.max(1, Math.floor(opts.limit ?? 12));

    return postgresClient.query<SpreadActivationRecord>(
      `WITH RECURSIVE anchors AS (
         SELECT n.id AS node_id, 1.0::real AS activation, 0 AS hop, ARRAY[n.id] AS path
         FROM ${ KnowledgeGraphModel.NODES_TABLE } n
         WHERE n.id = ANY($1::text[]) AND n.archived = false AND n.merged_into IS NULL
       ),
       spread AS (
         SELECT node_id, activation, hop, path FROM anchors
         UNION ALL
         SELECT
           next.id AS node_id,
           (s.activation * l.strength * $3::real)::real AS activation,
           s.hop + 1 AS hop,
           s.path || next.id AS path
         FROM spread s
         JOIN ${ KnowledgeGraphModel.LINKS_TABLE } l
           ON (l.src_id = s.node_id OR l.dst_id = s.node_id)
         JOIN ${ KnowledgeGraphModel.NODES_TABLE } next
           ON next.id = CASE WHEN l.src_id = s.node_id THEN l.dst_id ELSE l.src_id END
         WHERE s.hop < $2
           AND l.strength >= $4::real
           AND next.archived = false AND next.merged_into IS NULL
           AND NOT (next.id = ANY(s.path))
       ),
       ranked AS (
         SELECT node_id, MAX(activation) AS activation, MIN(hop) AS hop
         FROM spread
         GROUP BY node_id
       )
       SELECT n.*, r.activation, r.hop
       FROM ranked r
       JOIN ${ KnowledgeGraphModel.NODES_TABLE } n ON n.id = r.node_id
       ORDER BY r.activation DESC, n.link_count DESC, n.id ASC
       LIMIT $5`,
      [ids, maxHops, decay, minEdge, limit],
    );
  }

  /**
   * Resolve aliases, spread activation, fetch ranked nodes, and bump recall
   * counters in one transaction-local SQL statement. Recall must never write
   * `node_links`; edge reinforcement belongs to write/learning paths only.
   */
  static async recallByTerms(
    terms: string[],
    opts: EpisodicRecallOptions = {},
  ): Promise<SpreadActivationRecord[]> {
    const cleanTerms = Array.from(new Set(terms.map(term => term.trim()).filter(Boolean)));
    if (cleanTerms.length === 0) return [];

    const maxHops = Math.max(1, Math.floor(opts.maxHops ?? 2));
    const decay   = opts.decay   ?? 0.5;
    const minEdge = opts.minEdge ?? 0;
    const limit   = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 12)));
    const timeout = Math.max(250, Math.min(10_000, Math.floor(opts.statementTimeoutMs ?? 3_000)));

    return postgresClient.transaction(async(client) => {
      await client.query(`SET LOCAL statement_timeout = ${ timeout }`);

      const { rows } = await client.query<SpreadActivationRecord>(
        `WITH RECURSIVE input_terms AS (
           SELECT unnest($1::text[]) AS term
         ),
         normalized_terms AS (
           SELECT term, norm_alias(term) AS term_norm
           FROM input_terms
           WHERE norm_alias(term) <> ''
         ),
         exact_matches AS (
           SELECT DISTINCT ON (a.node_id)
             a.node_id, 1::real AS sim, 0 AS match_rank
           FROM normalized_terms t
           JOIN ${ KnowledgeGraphModel.ALIASES_TABLE } a ON a.alias_norm = t.term_norm
           JOIN ${ KnowledgeGraphModel.NODES_TABLE } n ON n.id = a.node_id
           WHERE n.archived = false AND n.merged_into IS NULL
           ORDER BY a.node_id, a.alias
         ),
         fuzzy_matches AS (
           SELECT DISTINCT ON (a.node_id)
             a.node_id, similarity(a.alias_norm, t.term_norm)::real AS sim, 1 AS match_rank
           FROM normalized_terms t
           JOIN ${ KnowledgeGraphModel.ALIASES_TABLE } a ON a.alias_norm % t.term_norm
           JOIN ${ KnowledgeGraphModel.NODES_TABLE } n ON n.id = a.node_id
           WHERE n.archived = false
             AND n.merged_into IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM exact_matches e WHERE e.node_id = a.node_id
             )
           ORDER BY a.node_id, similarity(a.alias_norm, t.term_norm) DESC, a.alias
         ),
         anchors AS (
           SELECT DISTINCT node_id
           FROM (
             SELECT node_id, sim, match_rank FROM exact_matches
             UNION ALL
             SELECT node_id, sim, match_rank FROM fuzzy_matches
           ) matches
           ORDER BY node_id
         ),
         spread AS (
           SELECT n.id AS node_id, 1.0::real AS activation, 0 AS hop, ARRAY[n.id] AS path
           FROM ${ KnowledgeGraphModel.NODES_TABLE } n
           JOIN anchors a ON a.node_id = n.id
           WHERE n.archived = false AND n.merged_into IS NULL
           UNION ALL
           SELECT
             next.id AS node_id,
             (s.activation * l.strength * $3::real)::real AS activation,
             s.hop + 1 AS hop,
             s.path || next.id AS path
           FROM spread s
           JOIN ${ KnowledgeGraphModel.LINKS_TABLE } l
             ON (l.src_id = s.node_id OR l.dst_id = s.node_id)
           JOIN ${ KnowledgeGraphModel.NODES_TABLE } next
             ON next.id = CASE WHEN l.src_id = s.node_id THEN l.dst_id ELSE l.src_id END
           WHERE s.hop < $2
             AND l.strength >= $4::real
             AND next.archived = false AND next.merged_into IS NULL
             AND NOT (next.id = ANY(s.path))
         ),
         ranked AS (
           SELECT node_id, MAX(activation) AS activation, MIN(hop) AS hop
           FROM spread
           GROUP BY node_id
         ),
         limited AS (
           SELECT n.*, r.activation, r.hop
           FROM ranked r
           JOIN ${ KnowledgeGraphModel.NODES_TABLE } n ON n.id = r.node_id
           ORDER BY r.activation DESC, n.link_count DESC, n.id ASC
           LIMIT $5
         ),
         recalled AS (
           UPDATE ${ KnowledgeGraphModel.NODES_TABLE } n
           SET recall_count = n.recall_count + 1,
               last_recalled_at = now(),
               updated_at = now()
           FROM limited l
           WHERE n.id = l.id
           RETURNING n.id
         )
         SELECT * FROM limited
         ORDER BY activation DESC, link_count DESC, id ASC`,
        [cleanTerms, maxHops, decay, minEdge, limit],
      );

      return rows;
    });
  }

  static async getNode(id: string): Promise<KnowledgeNodeRecord | null> {
    return postgresClient.queryOne<KnowledgeNodeRecord>(
      `SELECT * FROM ${ KnowledgeGraphModel.NODES_TABLE } WHERE id = $1 LIMIT 1`,
      [id],
    );
  }

  static async upsertNode(input: UpsertKnowledgeNodeInput): Promise<KnowledgeNodeRecord> {
    const row = await postgresClient.queryOne<KnowledgeNodeRecord>(
      `INSERT INTO ${ KnowledgeGraphModel.NODES_TABLE }
         (id, node_type, title, summary, detail, source, archived, merged_into)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         node_type = EXCLUDED.node_type,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         detail = EXCLUDED.detail,
         source = EXCLUDED.source,
         archived = EXCLUDED.archived,
         merged_into = EXCLUDED.merged_into,
         updated_at = now()
       RETURNING *`,
      [
        input.id,
        input.node_type ?? 'entity',
        input.title,
        input.summary ?? '',
        input.detail ?? null,
        input.source ?? null,
        input.archived ?? false,
        input.merged_into ?? null,
      ],
    );

    if (!row) throw new Error(`Failed to upsert knowledge node: ${ input.id }`);
    return row;
  }

  static async addAlias(nodeId: string, alias: string): Promise<NodeAliasRecord> {
    const row = await postgresClient.queryOne<NodeAliasRecord>(
      `INSERT INTO ${ KnowledgeGraphModel.ALIASES_TABLE } (alias, alias_norm, node_id)
       VALUES ($1, norm_alias($1), $2)
       ON CONFLICT (alias_norm, node_id) DO UPDATE SET alias = EXCLUDED.alias
       RETURNING *`,
      [alias, nodeId],
    );

    if (!row) throw new Error(`Failed to add alias "${ alias }" for node: ${ nodeId }`);
    return row;
  }

  static async linkNodes(srcId: string, dstId: string, relationType = 'related_to', strength = 0.3): Promise<NodeLinkRecord> {
    return postgresClient.transaction(async(client) => {
      const { rows } = await client.query<NodeLinkRecord>(
        `WITH inserted AS (
           INSERT INTO ${ KnowledgeGraphModel.LINKS_TABLE }
             (src_id, dst_id, relation_type, strength)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (src_id, dst_id, relation_type) DO UPDATE SET
             strength = EXCLUDED.strength
           RETURNING *, (xmax = 0) AS was_inserted
         ),
         bumped AS (
           UPDATE ${ KnowledgeGraphModel.NODES_TABLE } n
           SET link_count = link_count + 1, updated_at = now()
           FROM inserted i
           WHERE i.was_inserted
             AND n.id IN (i.src_id, i.dst_id)
           RETURNING n.id
         )
         SELECT src_id, dst_id, relation_type, strength, fire_count, last_fired_at, confirmed, created_at
         FROM inserted`,
        [srcId, dstId, relationType, strength],
      );
      if (!rows[0]) throw new Error(`Failed to link ${ srcId } -> ${ dstId } (${ relationType })`);
      return rows[0];
    });
  }

  static async reinforceLink(srcId: string, dstId: string, relationType = 'related_to'): Promise<NodeLinkRecord> {
    const row = await postgresClient.queryOne<NodeLinkRecord>(
      `UPDATE ${ KnowledgeGraphModel.LINKS_TABLE }
       SET strength = strength + 0.2 * (1 - strength),
           fire_count = fire_count + 1,
           last_fired_at = now()
       WHERE src_id = $1 AND dst_id = $2 AND relation_type = $3
       RETURNING *`,
      [srcId, dstId, relationType],
    );

    if (!row) throw new Error(`No link found to reinforce: ${ srcId } -> ${ dstId } (${ relationType })`);
    return row;
  }

  static async bumpRecalled(ids: string[]): Promise<KnowledgeNodeRecord[]> {
    const uniqueIds = Array.from(new Set(ids.map(id => id.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return [];

    return postgresClient.query<KnowledgeNodeRecord>(
      `UPDATE ${ KnowledgeGraphModel.NODES_TABLE }
       SET recall_count = recall_count + 1,
           last_recalled_at = now(),
           updated_at = now()
       WHERE id = ANY($1::text[])
       RETURNING *`,
      [uniqueIds],
    );
  }

  static async archiveNode(id: string): Promise<boolean> {
    const result = await postgresClient.queryWithResult(
      `UPDATE ${ KnowledgeGraphModel.NODES_TABLE }
       SET archived = true, updated_at = now()
       WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
