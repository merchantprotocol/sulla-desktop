/**
 * RulesModel — Persistent user-created rules in PostgreSQL.
 *
 * Backs the USER half of the rules system. Global rules live as markdown
 * files under `~/sulla/rules/global/`; the rows here are the rules the
 * human adds during a conversation (via the add_rule tool) that the
 * Security Conscience agent surfaces each turn.
 *
 * Rules are NEVER hard-deleted — they are soft-archived via `archived`
 * so the full history is always recoverable. An `enabled` flag lets a
 * rule be toggled off without archiving it. Mirrors ObservationsModel.
 *
 * DUAL-STORE NOTE: reads and writes ONLY Postgres — no Redis hash.
 */

import { postgresClient } from '../PostgresClient';

// ── Types ──────────────────────────────────────────────────────────────

export interface RuleRecord {
  id:         string;
  scope:      string;
  category:   string;
  title:      string;
  content:    string;
  severity:   string;
  enabled:    boolean;
  archived:   boolean;
  source:     string | null;
  created_at: string;
  updated_at: string | null;
}

export interface InsertRuleInput {
  id?:        string;
  scope?:     string;
  category?:  string;
  title:      string;
  content:    string;
  severity?:  string;
  enabled?:   boolean;
  source?:    string;
  created_at?: string;
}

export interface UpdateRuleInput {
  scope?:    string;
  category?: string;
  title?:    string;
  content?:  string;
  severity?: string;
  enabled?:  boolean;
  source?:   string;
}

// ── Tiny-ID generator (4-char) — same alphabet as observations ─────────

function generateTinyId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// ── Model ──────────────────────────────────────────────────────────────

export class RulesModel {
  private static readonly TABLE = 'sulla_rules';

  // ──────────────────────────────────────────────
  // Table bootstrap (idempotent) — mirrors migration 0042
  // ──────────────────────────────────────────────

  static async ensureTable(): Promise<void> {
    try {
      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ RulesModel.TABLE } (
          id          TEXT        PRIMARY KEY,
          scope       TEXT        NOT NULL DEFAULT 'user',
          category    TEXT        NOT NULL DEFAULT 'security',
          title       TEXT        NOT NULL,
          content     TEXT        NOT NULL,
          severity    TEXT        NOT NULL DEFAULT 'medium',
          enabled     BOOLEAN     NOT NULL DEFAULT true,
          archived    BOOLEAN     NOT NULL DEFAULT false,
          source      TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ
        )
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_sulla_rules_active_severity
          ON ${ RulesModel.TABLE } (archived, enabled, severity, created_at DESC)
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_sulla_rules_category
          ON ${ RulesModel.TABLE } (archived, enabled, category)
      `);
      // Trigram GIN index keeps `content ILIKE '%word%'` search index-assisted
      // as the table grows. Best-effort — pg_trgm may be unavailable.
      try {
        await postgresClient.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        await postgresClient.query(`
          CREATE INDEX IF NOT EXISTS idx_sulla_rules_content_trgm
            ON ${ RulesModel.TABLE } USING gin (content gin_trgm_ops)
        `);
      } catch (trgmErr) {
        console.warn('[RulesModel] pg_trgm index unavailable (non-fatal):', trgmErr);
      }
    } catch (err) {
      console.error('[RulesModel] Failed to ensure table:', err);
    }
  }

  // ──────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────

  /** Insert a new rule row. Returns the full inserted record. */
  static async insert(input: InsertRuleInput): Promise<RuleRecord> {
    const id = input.id || generateTinyId();
    const rows = await postgresClient.query<RuleRecord>(
      `INSERT INTO ${ RulesModel.TABLE }
         (id, scope, category, title, content, severity, enabled, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        input.scope    ?? 'user',
        input.category ?? 'security',
        input.title,
        input.content,
        input.severity ?? 'medium',
        input.enabled  ?? true,
        input.source   ?? null,
        input.created_at ?? new Date().toISOString(),
      ],
    );
    return rows[0];
  }

  /** Update mutable fields of an existing rule. Sets updated_at = now(). */
  static async update(id: string, changes: UpdateRuleInput): Promise<RuleRecord | null> {
    const setClauses: string[] = ['updated_at = now()'];
    const values: any[] = [];
    let idx = 1;

    const assign = (col: string, val: any) => {
      setClauses.push(`${ col } = $${ idx++ }`);
      values.push(val);
    };

    if (changes.scope    !== undefined) assign('scope', changes.scope);
    if (changes.category !== undefined) assign('category', changes.category);
    if (changes.title    !== undefined) assign('title', changes.title);
    if (changes.content  !== undefined) assign('content', changes.content);
    if (changes.severity !== undefined) assign('severity', changes.severity);
    if (changes.enabled  !== undefined) assign('enabled', changes.enabled);
    if (changes.source   !== undefined) assign('source', changes.source);

    if (setClauses.length === 1) return null; // nothing to update
    values.push(id);

    const rows = await postgresClient.query<RuleRecord>(
      `UPDATE ${ RulesModel.TABLE } SET ${ setClauses.join(', ') }
       WHERE id = $${ idx } RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  /** Soft-delete: sets archived = true. Never hard-deletes. */
  static async archive(id: string): Promise<boolean> {
    const result = await postgresClient.queryWithResult(
      `UPDATE ${ RulesModel.TABLE } SET archived = true, updated_at = now()
       WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Retrieve a single rule by id (any archived state). */
  static async getById(id: string): Promise<RuleRecord | null> {
    const rows = await postgresClient.query<RuleRecord>(
      `SELECT * FROM ${ RulesModel.TABLE } WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * List active (non-archived, enabled) rules, most severe first then
   * recency. Optionally filter by category and/or severity.
   */
  static async listActive(opts: { category?: string; severity?: string; limit?: number; includeDisabled?: boolean } = {}): Promise<RuleRecord[]> {
    const { category, severity, limit = 100, includeDisabled = false } = opts;
    const ORDER = `
      CASE severity
        WHEN '🔴' THEN 0 WHEN 'critical' THEN 0 WHEN 'high'   THEN 1
        WHEN '🟡' THEN 2 WHEN 'medium'   THEN 2
        WHEN '⚪' THEN 3 WHEN 'low'      THEN 3
        ELSE 4
      END ASC, created_at DESC`;

    const conds: string[] = ['archived = false'];
    const values: any[] = [];
    let idx = 1;
    if (!includeDisabled) conds.push('enabled = true');
    if (category) { conds.push(`category = $${ idx++ }`); values.push(category); }
    if (severity) { conds.push(`severity = $${ idx++ }`); values.push(severity); }
    values.push(limit);

    return postgresClient.query<RuleRecord>(
      `SELECT * FROM ${ RulesModel.TABLE }
       WHERE ${ conds.join(' AND ') }
       ORDER BY ${ ORDER }
       LIMIT $${ idx }`,
      values,
    );
  }

  private static readonly STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'these', 'those',
    'have', 'has', 'had', 'about', 'into', 'from', 'when', 'where', 'what', 'which', 'who',
    'how', 'why', 'did', 'does', 'doing', 'will', 'would', 'could', 'should', 'can', 'not',
    'you', 'your', 'our', 'his', 'her', 'its', 'their', 'them', 'they', 'all', 'any', 'some',
    'just', 'than', 'then', 'too', 'very', 'out', 'now', 'get', 'got', 'been', 'being', 'rule',
  ]);

  /** Break a free-text query into meaningful search words. */
  static tokenizeQuery(query: string): string[] {
    return Array.from(new Set(
      (query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])
        .filter(w => w.length >= 3 && !RulesModel.STOPWORDS.has(w)),
    ));
  }

  /**
   * Word-level ILIKE search across title + content. Ranks exact-phrase
   * hits first, then by distinct word matches, then recency. Falls back
   * to plain phrase matching when no usable words remain.
   */
  static async search(query: string, limit = 20, opts: { includeArchived?: boolean; includeDisabled?: boolean } = {}): Promise<RuleRecord[]> {
    const activeCond = opts.includeArchived ? 'true' : 'archived = false';
    const enabledCond = opts.includeDisabled ? 'true' : 'enabled = true';
    const words = RulesModel.tokenizeQuery(query);
    const haystack = "(title || ' ' || content)";

    if (words.length === 0) {
      return postgresClient.query<RuleRecord>(
        `SELECT * FROM ${ RulesModel.TABLE }
         WHERE (${ activeCond }) AND (${ enabledCond })
           AND ${ haystack } ILIKE $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [`%${ query }%`, limit],
      );
    }

    // $1 = full phrase, $2 = limit, $3..$n = individual words
    const wordConds = words.map((_, i) => `${ haystack } ILIKE $${ i + 3 }`);
    const matchScore = words.map((_, i) => `(${ haystack } ILIKE $${ i + 3 })::int`).join(' + ');
    return postgresClient.query<RuleRecord>(
      `SELECT * FROM ${ RulesModel.TABLE }
       WHERE (${ activeCond }) AND (${ enabledCond })
         AND (${ haystack } ILIKE $1 OR ${ wordConds.join(' OR ') })
       ORDER BY (${ haystack } ILIKE $1)::int DESC, (${ matchScore }) DESC, created_at DESC
       LIMIT $2`,
      [`%${ query }%`, limit, ...words.map(w => `%${ w }%`)],
    );
  }

  /**
   * Check whether a substantially similar active rule already exists
   * (exact normalised title/content match or substring containment).
   * Returns the matching row or null. Used by add_rule to update in place
   * instead of creating near-duplicates.
   */
  static async findDuplicate(title: string, content: string): Promise<RuleRecord | null> {
    const rows = await RulesModel.listActive({ limit: 500, includeDisabled: true });
    const normalise = (s: string) =>
      (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const normTitle = normalise(title);
    const normContent = normalise(content);

    for (const row of rows) {
      if (normTitle && normalise(row.title) === normTitle) return row;
      const existing = normalise(row.content);
      if (existing === normContent) return row;
      if (normContent && (existing.includes(normContent) || normContent.includes(existing))) return row;
    }
    return null;
  }
}
