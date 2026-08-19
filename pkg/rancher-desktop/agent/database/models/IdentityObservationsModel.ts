/**
 * IdentityObservationsModel — domain-keyed identity observation storage.
 *
 * The focused counterpart to ObservationsModel (the GENERAL observer).
 * Every row belongs to a DOMAIN mirroring ~/sulla/identity/
 * (human / business / world / agent) and carries a certainty LEVEL
 * instead of a priority:
 *
 *   3 — stated fact: the subject directly told us this
 *   2 — derived fact: established from conversation evidence, not stated outright
 *   1 — conclusion: reasoned from L3/L2 facts (personality, style, habits)
 *
 * Rows are NEVER hard-deleted — soft-archived via `archived = true` so the
 * full history is always recoverable (same covenant as ObservationsModel).
 */

import { ObservationsModel } from './ObservationsModel';
import { postgresClient } from '../PostgresClient';

// ── Types ──────────────────────────────────────────────────────────────

export type IdentityDomain = 'human' | 'business' | 'world' | 'agent';

export const IDENTITY_DOMAINS: IdentityDomain[] = ['human', 'business', 'world', 'agent'];
const MAX_CONTENT_CHARS = 1200;
const MAX_BASIS_CHARS = 600;
const MAX_LABEL_CHARS = 80;
const MAX_SOURCE_CHARS = 120;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 100;

export interface IdentityObservationRecord {
  id:         string;
  domain:     string;
  level:      number;
  category:   string | null;
  content:    string;
  basis:      string | null;
  created_at: string | Date;
  updated_at: string | Date | null;
  archived:   boolean;
  source:     string | null;
}

export interface InsertIdentityObservationInput {
  id?:       string;
  domain:    string;
  level:     number;
  category?: string;
  content:   string;
  basis?:    string;
  source?:   string;
}

export interface UpdateIdentityObservationInput {
  level?:    number;
  category?: string;
  content?:  string;
  basis?:    string;
  source?:   string;
}

// ── Tiny-ID generator (4-char, same alphabet as ObservationsModel) ─────

function generateTinyId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

export function normalizeIdentityLevel(level: unknown): number {
  const n = Number(level);
  if (n === 1 || n === 2 || n === 3) return n;
  throw new Error(`Invalid identity certainty level "${ String(level) }"; expected 1, 2, or 3.`);
}

export function normalizeIdentityDomain(domain: unknown): IdentityDomain {
  const normalized = typeof domain === 'string' && domain.trim()
    ? domain.trim().toLowerCase()
    : 'human';

  if (IDENTITY_DOMAINS.includes(normalized as IdentityDomain)) {
    return normalized as IdentityDomain;
  }

  throw new Error(`Invalid identity domain "${ String(domain) }"; expected one of: ${ IDENTITY_DOMAINS.join(', ') }`);
}

export function normalizeIdentityLimit(limit: unknown, fallback = DEFAULT_LIST_LIMIT): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIST_LIMIT);
}

function normalizeRequiredText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${ field } must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${ field } is required.`);
  }
  if (trimmed.length > maxChars) {
    throw new Error(`${ field } must be ${ maxChars } characters or fewer.`);
  }
  return trimmed;
}

function normalizeOptionalText(value: unknown, field: string, maxChars: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${ field } must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxChars) {
    throw new Error(`${ field } must be ${ maxChars } characters or fewer.`);
  }
  return trimmed;
}

export function formatIdentityObservationDate(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.slice(0, 10) : parsed.toISOString().slice(0, 10);
  }

  return '';
}

// ── Model ──────────────────────────────────────────────────────────────

export class IdentityObservationsModel {
  private static readonly TABLE = 'identity_observations';

  static async ensureTable(): Promise<void> {
    try {
      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ IdentityObservationsModel.TABLE } (
          id          TEXT        PRIMARY KEY,
          domain      TEXT        NOT NULL DEFAULT 'human' CHECK (domain IN ('human', 'business', 'world', 'agent')),
          level       SMALLINT    NOT NULL DEFAULT 2 CHECK (level IN (1, 2, 3)),
          category    TEXT,
          content     TEXT        NOT NULL,
          basis       TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ,
          archived    BOOLEAN     NOT NULL DEFAULT false,
          source      TEXT
        )
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_identity_obs_domain_level_created
          ON ${ IdentityObservationsModel.TABLE } (domain, archived, level DESC, created_at DESC)
      `);
    } catch (err) {
      console.error('[IdentityObservationsModel] Failed to ensure table:', err);
    }
  }

  // ──────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────

  static async insert(input: InsertIdentityObservationInput): Promise<IdentityObservationRecord> {
    const id = input.id || generateTinyId();
    const category = normalizeOptionalText(input.category, 'category', MAX_LABEL_CHARS);
    const basis = normalizeOptionalText(input.basis, 'basis', MAX_BASIS_CHARS);
    const source = normalizeOptionalText(input.source, 'source', MAX_SOURCE_CHARS);
    const rows = await postgresClient.query<IdentityObservationRecord>(
      `INSERT INTO ${ IdentityObservationsModel.TABLE } (id, domain, level, category, content, basis, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        normalizeIdentityDomain(input.domain),
        normalizeIdentityLevel(input.level),
        category ?? null,
        normalizeRequiredText(input.content, 'content', MAX_CONTENT_CHARS),
        basis ?? null,
        source ?? null,
      ],
    );
    return rows[0];
  }

  static async update(id: string, changes: UpdateIdentityObservationInput): Promise<IdentityObservationRecord | null> {
    const setClauses: string[] = ['updated_at = now()'];
    const values: any[] = [];
    let idx = 1;

    if (changes.level !== undefined) {
      setClauses.push(`level = $${ idx++ }`);
      values.push(normalizeIdentityLevel(changes.level));
    }
    if (changes.category !== undefined) {
      setClauses.push(`category = $${ idx++ }`);
      values.push(normalizeOptionalText(changes.category, 'category', MAX_LABEL_CHARS));
    }
    if (changes.content !== undefined) {
      setClauses.push(`content = $${ idx++ }`);
      values.push(normalizeRequiredText(changes.content, 'content', MAX_CONTENT_CHARS));
    }
    if (changes.basis !== undefined) {
      setClauses.push(`basis = $${ idx++ }`);
      values.push(normalizeOptionalText(changes.basis, 'basis', MAX_BASIS_CHARS));
    }
    if (changes.source !== undefined) {
      setClauses.push(`source = $${ idx++ }`);
      values.push(normalizeOptionalText(changes.source, 'source', MAX_SOURCE_CHARS));
    }

    if (setClauses.length === 1) return null; // nothing to update
    values.push(id);

    const rows = await postgresClient.query<IdentityObservationRecord>(
      `UPDATE ${ IdentityObservationsModel.TABLE } SET ${ setClauses.join(', ') }
       WHERE id = $${ idx } RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  /** Soft-delete: sets archived = true. Never hard-deletes. */
  static async archive(id: string): Promise<boolean> {
    const result = await postgresClient.queryWithResult(
      `UPDATE ${ IdentityObservationsModel.TABLE } SET archived = true, updated_at = now()
       WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  static async getById(id: string): Promise<IdentityObservationRecord | null> {
    const rows = await postgresClient.query<IdentityObservationRecord>(
      `SELECT * FROM ${ IdentityObservationsModel.TABLE } WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * List active rows for a domain, most certain first then most recent:
   * ORDER BY level DESC (stated → derived → concluded), created_at DESC.
   */
  static async listActive(
    domain: string,
    opts: { level?: number; category?: string; limit?: number } = {},
  ): Promise<IdentityObservationRecord[]> {
    const normalizedDomain = normalizeIdentityDomain(domain);
    const conds = ['archived = false', 'domain = $1'];
    const values: any[] = [normalizedDomain];
    let idx = 2;

    if (opts.level !== undefined) {
      conds.push(`level = $${ idx++ }`);
      values.push(normalizeIdentityLevel(opts.level));
    }
    if (opts.category) {
      conds.push(`category = $${ idx++ }`);
      values.push(normalizeOptionalText(opts.category, 'category', MAX_LABEL_CHARS));
    }
    values.push(normalizeIdentityLimit(opts.limit, DEFAULT_LIST_LIMIT));

    return postgresClient.query<IdentityObservationRecord>(
      `SELECT * FROM ${ IdentityObservationsModel.TABLE }
       WHERE ${ conds.join(' AND ') }
       ORDER BY level DESC, created_at DESC
       LIMIT $${ idx }`,
      values,
    );
  }

  /**
   * Word-level ILIKE search within one domain — same tokenizer and ranking
   * shape as ObservationsModel.search (phrase hit → word-match count), but
   * level-weighted so stated facts outrank conclusions at equal relevance.
   */
  static async search(
    domain: string,
    query: string,
    limit = 20,
    includeArchived = false,
  ): Promise<IdentityObservationRecord[]> {
    const normalizedDomain = normalizeIdentityDomain(domain);
    const normalizedLimit = normalizeIdentityLimit(limit, 20);
    const activeCond = includeArchived ? 'true' : 'archived = false';
    const words = ObservationsModel.tokenizeQuery(query);

    if (words.length === 0) {
      return postgresClient.query<IdentityObservationRecord>(
        `SELECT * FROM ${ IdentityObservationsModel.TABLE }
         WHERE (${ activeCond }) AND domain = $1
           AND content ILIKE $2
         ORDER BY level DESC, created_at DESC
         LIMIT $3`,
        [normalizedDomain, `%${ query }%`, normalizedLimit],
      );
    }

    // $1 = domain, $2 = full phrase, $3 = limit, $4..$n = individual words
    const wordConds = words.map((_, i) => `content ILIKE $${ i + 4 }`);
    const matchScore = words.map((_, i) => `(content ILIKE $${ i + 4 })::int`).join(' + ');
    return postgresClient.query<IdentityObservationRecord>(
      `SELECT * FROM ${ IdentityObservationsModel.TABLE }
       WHERE (${ activeCond }) AND domain = $1
         AND (content ILIKE $2 OR ${ wordConds.join(' OR ') })
       ORDER BY (content ILIKE $2)::int DESC, (${ matchScore }) DESC, level DESC, created_at DESC
       LIMIT $3`,
      [normalizedDomain, `%${ query }%`, normalizedLimit, ...words.map(w => `%${ w }%`)],
    );
  }

  /**
   * Check whether a substantially similar active row already exists in the
   * domain (exact normalised match or substring containment). Same logic as
   * ObservationsModel.findDuplicate, scoped by domain.
   */
  static async findDuplicate(domain: string, content: string): Promise<IdentityObservationRecord | null> {
    const rows = await IdentityObservationsModel.listActive(normalizeIdentityDomain(domain), { limit: 500 });
    const normalise = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const norm = normalise(normalizeRequiredText(content, 'content', MAX_CONTENT_CHARS));

    for (const row of rows) {
      const existing = normalise(row.content);
      if (existing === norm) return row;
      if (existing.includes(norm) || norm.includes(existing)) return row;
    }
    return null;
  }
}
