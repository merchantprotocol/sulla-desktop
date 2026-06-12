/**
 * ObservationsModel — Persistent observation storage in PostgreSQL.
 *
 * Replaces the serialized JSON array under the `observationalMemory`
 * key in sulla_settings.  Observations are NEVER hard-deleted — they
 * are soft-archived via `archived = true` so the full history is
 * always recoverable.
 *
 * DUAL-STORE NOTE: This model reads and writes ONLY Postgres.  It does
 * not interact with the Redis sulla_settings hash.  The old serialized
 * key is left in place for back-compat fallbacks during the transition
 * window.
 */

import { postgresClient } from '../PostgresClient';

// ── Types ──────────────────────────────────────────────────────────────

export interface ObservationRecord {
  id:         string;
  priority:   string;
  content:    string;
  created_at: string;
  updated_at: string | null;
  archived:   boolean;
  source:     string | null;
}

export interface InsertObservationInput {
  id:        string;
  priority:  string;
  content:   string;
  source?:   string;
  /** ISO timestamp to preserve original timestamp on import */
  created_at?: string;
}

export interface UpdateObservationInput {
  priority?: string;
  content?:  string;
  source?:   string;
}

// ── Tiny-ID generator (4-char) ─────────────────────────────────────────

function generateTinyId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// ── Model ──────────────────────────────────────────────────────────────

export class ObservationsModel {
  private static readonly TABLE = 'observations';

  // ──────────────────────────────────────────────
  // Table bootstrap (idempotent)
  // ──────────────────────────────────────────────

  static async ensureTable(): Promise<void> {
    try {
      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ ObservationsModel.TABLE } (
          id          TEXT        PRIMARY KEY,
          priority    TEXT        NOT NULL DEFAULT 'medium',
          content     TEXT        NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ,
          archived    BOOLEAN     NOT NULL DEFAULT false,
          source      TEXT
        )
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_observations_archived_priority_created
          ON ${ ObservationsModel.TABLE } (archived, priority, created_at DESC)
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_observations_archived_created
          ON ${ ObservationsModel.TABLE } (archived, created_at DESC)
      `);
    } catch (err) {
      console.error('[ObservationsModel] Failed to ensure table:', err);
    }
  }

  // ──────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────

  /**
   * Insert a new observation row.
   * Returns the full inserted record.
   */
  static async insert(input: InsertObservationInput): Promise<ObservationRecord> {
    const id = input.id || generateTinyId();
    const rows = await postgresClient.query<ObservationRecord>(
      `INSERT INTO ${ ObservationsModel.TABLE } (id, priority, content, source, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, input.priority || 'medium', input.content, input.source ?? null, input.created_at ?? new Date().toISOString()],
    );
    return rows[0];
  }

  /**
   * Update mutable fields of an existing observation.
   * Sets updated_at = now().
   */
  static async update(id: string, changes: UpdateObservationInput): Promise<ObservationRecord | null> {
    const setClauses: string[] = ['updated_at = now()'];
    const values: any[] = [];
    let idx = 1;

    if (changes.priority !== undefined) { setClauses.push(`priority = $${ idx++ }`); values.push(changes.priority); }
    if (changes.content  !== undefined) { setClauses.push(`content  = $${ idx++ }`); values.push(changes.content); }
    if (changes.source   !== undefined) { setClauses.push(`source   = $${ idx++ }`); values.push(changes.source); }

    if (setClauses.length === 1) return null; // nothing to update
    values.push(id);

    const rows = await postgresClient.query<ObservationRecord>(
      `UPDATE ${ ObservationsModel.TABLE } SET ${ setClauses.join(', ') }
       WHERE id = $${ idx } RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  /**
   * Soft-delete: sets archived = true.  Never hard-deletes.
   */
  static async archive(id: string): Promise<boolean> {
    const result = await postgresClient.queryWithResult(
      `UPDATE ${ ObservationsModel.TABLE } SET archived = true, updated_at = now()
       WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Retrieve a single observation by id (any archived state).
   */
  static async getById(id: string): Promise<ObservationRecord | null> {
    const rows = await postgresClient.query<ObservationRecord>(
      `SELECT * FROM ${ ObservationsModel.TABLE } WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * List active (non-archived) observations, sorted by priority then recency.
   * @param priority  Optional priority filter (e.g. 'critical', 'high').
   * @param limit     Max rows to return (default 100).
   */
  static async listActive(priority?: string, limit = 100): Promise<ObservationRecord[]> {
    const ORDER = `
      CASE priority
        WHEN '🔴' THEN 0 WHEN 'critical' THEN 0 WHEN 'high'   THEN 1
        WHEN '🟡' THEN 2 WHEN 'medium'   THEN 2
        WHEN '⚪' THEN 3 WHEN 'low'      THEN 3
        ELSE 4
      END ASC, created_at DESC`;

    if (priority) {
      return postgresClient.query<ObservationRecord>(
        `SELECT * FROM ${ ObservationsModel.TABLE }
         WHERE archived = false AND priority = $1
         ORDER BY ${ ORDER }
         LIMIT $2`,
        [priority, limit],
      );
    }

    return postgresClient.query<ObservationRecord>(
      `SELECT * FROM ${ ObservationsModel.TABLE }
       WHERE archived = false
       ORDER BY ${ ORDER }
       LIMIT $1`,
      [limit],
    );
  }

  /**
   * Common words that carry no search signal — excluded from word-level
   * matching so "what did we decide about the relay server" only searches
   * the meaningful terms (decide, relay, server).
   */
  private static readonly STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'these', 'those',
    'have', 'has', 'had', 'about', 'into', 'from', 'when', 'where', 'what', 'which', 'who',
    'how', 'why', 'did', 'does', 'doing', 'will', 'would', 'could', 'should', 'can', 'not',
    'you', 'your', 'our', 'his', 'her', 'its', 'their', 'them', 'they', 'all', 'any', 'some',
    'just', 'than', 'then', 'too', 'very', 'out', 'now', 'get', 'got', 'been', 'being',
  ]);

  /**
   * Break a free-text query into meaningful search words: lowercased,
   * alphanumeric, ≥3 chars, stopwords removed, deduplicated.
   * Exported so the search tool can report which words were matched.
   */
  static tokenizeQuery(query: string): string[] {
    return Array.from(new Set(
      (query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])
        .filter(w => w.length >= 3 && !ObservationsModel.STOPWORDS.has(w)),
    ));
  }

  /**
   * Word-level ILIKE search on the content field. The query is split into
   * meaningful words (see tokenizeQuery) and a row matches if it contains
   * ANY of them. Results are ranked: exact-phrase hits first, then by how
   * many distinct words matched, then recency. Falls back to plain phrase
   * matching when the query yields no usable words (symbols, stopwords
   * only, or wildcard patterns like '%').
   *
   * @param query   Free-text search query.
   * @param limit   Max rows (default 20).
   * @param includeArchived  When true, includes archived rows too.
   */
  static async search(query: string, limit = 20, includeArchived = false): Promise<ObservationRecord[]> {
    const activeCond = includeArchived ? 'true' : 'archived = false';
    const words = ObservationsModel.tokenizeQuery(query);

    if (words.length === 0) {
      return postgresClient.query<ObservationRecord>(
        `SELECT * FROM ${ ObservationsModel.TABLE }
         WHERE (${ activeCond })
           AND content ILIKE $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [`%${ query }%`, limit],
      );
    }

    // $1 = full phrase, $2 = limit, $3..$n = individual words
    const wordConds = words.map((_, i) => `content ILIKE $${ i + 3 }`);
    const matchScore = words.map((_, i) => `(content ILIKE $${ i + 3 })::int`).join(' + ');
    return postgresClient.query<ObservationRecord>(
      `SELECT * FROM ${ ObservationsModel.TABLE }
       WHERE (${ activeCond })
         AND (content ILIKE $1 OR ${ wordConds.join(' OR ') })
       ORDER BY (content ILIKE $1)::int DESC, (${ matchScore }) DESC, created_at DESC
       LIMIT $2`,
      [`%${ query }%`, limit, ...words.map(w => `%${ w }%`)],
    );
  }

  /**
   * Check whether a substantially similar active observation already exists
   * (exact normalised match or substring containment).
   * Returns the matching row or null.
   */
  static async findDuplicate(content: string): Promise<ObservationRecord | null> {
    // Pull all active observations and do the normalisation in JS
    // (same logic as the old add_observational_memory.ts to keep parity).
    const rows = await ObservationsModel.listActive(undefined, 500);
    const normalise = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const norm = normalise(content);

    for (const row of rows) {
      const existing = normalise(row.content);
      if (existing === norm) return row;
      if (existing.includes(norm) || norm.includes(existing)) return row;
    }
    return null;
  }

  // ──────────────────────────────────────────────
  // Bulk import from legacy serialised format
  // ──────────────────────────────────────────────

  /**
   * Import an array of legacy observation objects into the table.
   * Skips rows whose id already exists (idempotent).
   * Used by the migration runner on first boot after 0028 runs.
   */
  static async importLegacy(
    entries: Array<{ id?: string; priority?: string; content?: string; timestamp?: string }>,
  ): Promise<number> {
    let imported = 0;
    for (const entry of entries) {
      if (!entry.content) continue;
      const id = entry.id || generateTinyId();
      try {
        await postgresClient.query(
          `INSERT INTO ${ ObservationsModel.TABLE } (id, priority, content, created_at, source)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            entry.priority || 'medium',
            entry.content,
            entry.timestamp ? new Date(entry.timestamp).toISOString() : new Date().toISOString(),
            'legacy_import',
          ],
        );
        imported++;
      } catch (err) {
        console.warn(`[ObservationsModel] importLegacy: failed to import id=${ id }:`, err);
      }
    }
    return imported;
  }
}
