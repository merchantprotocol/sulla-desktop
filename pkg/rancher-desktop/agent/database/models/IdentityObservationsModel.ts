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

export type IdentityDomain = 'human' | 'business' | 'world' | 'agent' | 'environment' | 'projects' | 'skills';

export const IDENTITY_DOMAINS: IdentityDomain[] = ['human', 'business', 'world', 'agent', 'environment', 'projects', 'skills'];
const MAX_CONTENT_CHARS = 1200;
const MAX_BASIS_CHARS = 600;
const MAX_LABEL_CHARS = 80;
const MAX_SOURCE_CHARS = 120;
const MAX_EVIDENCE_CHARS = 600;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 100;
/**
 * Dedup scanning deliberately reads MORE rows than any public list/recall
 * path ever returns (MAX_LIST_LIMIT=100) — duplicate-checking must cover the
 * whole domain, not just the page a human/tool would want back. A domain
 * regrowing past 100 active rows is exactly the regime where silent
 * duplication matters most (human hit 70, agent hit 52 in the 2026-08-19
 * pollution audit, before either was capped by this scan).
 */
const MAX_DEDUP_SCAN = 500;

/**
 * Per-domain closed category sets, transcribed from each domain's own focus
 * text in GraphRegistry.ts (every domain presents its "Record: - x: ... - y:
 * ..." list as an exhaustive scheme, not examples). Enforced at the DB
 * boundary so a miscategorized write fails with a reason INSTEAD of silently
 * landing — a tool error at the decision moment is what a prompt reject-list
 * could never be: unignorable. `agent` gets an EMPTY set, not an omission —
 * the agent domain's certainty/kind field is `kind` (correction | constraint
 * | method | commitment | preference), not `category`; the writerNote used
 * to say "category — the kind: ..." which pointed the writer at the wrong
 * column entirely (silently landing in `category`, leaving `kind` — the
 * field validateKindForDomain actually enforces — always null). Rejecting
 * `category` outright on this domain forces the correct field.
 */
const DOMAIN_CATEGORIES: Partial<Record<IdentityDomain, string[]>> = {
  human:       ['identity', 'relationship', 'association', 'personality', 'habit', 'preference', 'goal'],
  business:    ['identity', 'model', 'operations', 'market', 'priorities', 'constraints', 'assets'],
  world:       ['event', 'condition', 'trend', 'actor'],
  agent:       [],
  environment: ['fact', 'tool', 'path', 'build', 'limit', 'method', 'anti-pattern', 'process'],
  projects:    ['project', 'structure', 'priority', 'decision', 'process', 'relationship', 'blocker'],
  skills:      ['provenance', 'success', 'failure', 'gap', 'inventory'],
};

/**
 * Blunt content lint for the single most common pollution class found in the
 * 2026-08-19 domain audit: this-session task/engineering status recorded as
 * if it were durable identity. Every domain's writer prompt already says
 * "reject this" in prose; prose alone kept eroding (business hit 44 rows,
 * ~40 tagged subject:agent.user; world was 10/10 off-topic). This is the
 * first MECHANICAL backstop — a validation error the writer model sees
 * in-context at the exact decision point, not a rule 2000 tokens upstream.
 * Deliberately narrow (specific technical signatures only) to avoid
 * false-positiving on legitimate content like "the business merged with X".
 */
const WORK_STATE_CONTENT_RE = /\bPR ?#\d+\b|\bcommit\s+[0-9a-f]{7,40}\b|\b(?:feat|fix|chore|refactor|hb)\/[a-z0-9][a-z0-9-]*\b|\bdraft PR\b|\btsc --noEmit\b|\bworktree\b/i;

/** Field contract for skills-domain rows (GraphRegistry.ts writerNote): every
 *  row must name the exact skill it is about, e.g. "Skill 'pdf-fill' …". */
const SKILLS_SLUG_CONTENT_RE = /\bskill\s+'[a-z0-9][a-z0-9-]*'/i;

export type IdentityObservationSubject = 'agent' | 'agent.user';
export type IdentityObservationKind = 'correction' | 'constraint' | 'method' | 'commitment' | 'preference';

export interface IdentityObservationRecord {
  id:         string;
  domain:     string;
  level:      number;
  category:   string | null;
  content:    string;
  basis:      string | null;
  subject:    string | null;
  evidence:   string | null;
  confidence: number | null;
  kind:       string | null;
  skill_slug: string | null;
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
  subject?:  string;
  evidence?: string;
  confidence?: number;
  kind?:     string;
  skillSlug?: string;
  source?:   string;
}

export interface UpdateIdentityObservationInput {
  level?:    number;
  category?: string;
  content?:  string;
  basis?:    string;
  subject?:  string;
  evidence?: string;
  confidence?: number;
  kind?:     string;
  skillSlug?: string;
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

function normalizeIdentitySubject(value: unknown): IdentityObservationSubject | null | undefined {
  const normalized = normalizeOptionalText(value, 'subject', MAX_LABEL_CHARS);
  if (normalized === undefined || normalized === null) return normalized;
  if (normalized === 'agent' || normalized === 'agent.user') return normalized;
  throw new Error('subject must be "agent" or "agent.user" when provided.');
}

function normalizeIdentityKind(value: unknown): IdentityObservationKind | null | undefined {
  const normalized = normalizeOptionalText(value, 'kind', MAX_LABEL_CHARS);
  if (normalized === undefined || normalized === null) return normalized;
  if (['correction', 'constraint', 'method', 'commitment', 'preference'].includes(normalized)) {
    return normalized as IdentityObservationKind;
  }
  throw new Error('kind must be one of: correction, constraint, method, commitment, preference.');
}

/** Kebab-case artifact slug — same shape marketplace/scaffold requires. */
const SKILL_SLUG_SHAPE_RE = /^[a-z0-9][a-z0-9-]*$/;

function normalizeSkillSlug(value: unknown): string | null | undefined {
  const normalized = normalizeOptionalText(value, 'skillSlug', MAX_LABEL_CHARS);
  if (normalized === undefined || normalized === null) return normalized;
  const lower = normalized.toLowerCase();
  if (!SKILL_SLUG_SHAPE_RE.test(lower)) {
    throw new Error('skillSlug must be a kebab-case artifact slug (lowercase letters, digits, hyphens — e.g. "pdf-fill").');
  }
  return lower;
}

function normalizeConfidence(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error('confidence must be a number from 0 to 1.');
  }
  return n;
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

/**
 * Mechanical write guards — the tool-layer backstop behind the writer
 * prompts' prose reject-lists. Prose alone eroded on every domain in the
 * 2026-08-19 audit; these throw at insert/update time so the writer model
 * sees a validation error in-context at the exact decision point instead of
 * a rule far upstream it can silently ignore. Called for BOTH insert (full
 * field set) and update (only the fields actually being changed).
 */
function validateCategoryForDomain(domain: IdentityDomain, category: string | null | undefined): void {
  if (category == null) return;
  const allowed = DOMAIN_CATEGORIES[domain];
  if (allowed === undefined) return; // no closed set registered for this domain — free text
  if (allowed.length === 0) {
    throw new Error(`category is not used in the "${ domain }" domain — did you mean to set kind instead? (agent-domain rows use kind: correction | constraint | method | commitment | preference.)`);
  }
  if (!allowed.includes(category)) {
    throw new Error(`category "${ category }" is not valid for domain "${ domain }"; expected one of: ${ allowed.join(', ') }.`);
  }
}

function validateSubjectForDomain(domain: IdentityDomain, subject: string | null | undefined): void {
  if (subject == null) return;
  if (domain !== 'agent') {
    throw new Error(`subject is only valid in the agent domain (got domain "${ domain }"). A row about the agent or the agent+human pair (subject agent.user) belongs in the agent domain, not here — this is the exact misfiling pattern the 2026-08-19 business-domain audit found (40 of 44 rows).`);
  }
}

/**
 * Same gap as validateSubjectForDomain, same fix: `kind` (correction |
 * constraint | method | commitment | preference) is agent-domain field
 * contract per the agent writerNote in GraphRegistry.ts, but was never
 * actually gated to that domain — any domain could set it and pass. Caught
 * during the same review pass that found the subject gap.
 */
function validateKindForDomain(domain: IdentityDomain, kind: string | null | undefined): void {
  if (kind == null) return;
  if (domain !== 'agent') {
    throw new Error(`kind is only valid in the agent domain (got domain "${ domain }") — it is the agent-domain field contract (correction | constraint | method | commitment | preference), not a general-purpose tag.`);
  }
}

function validateContentForDomain(domain: IdentityDomain, content: string): void {
  if (WORK_STATE_CONTENT_RE.test(content)) {
    throw new Error('content reads as task/engineering status (a PR/commit/branch/tsc/worktree reference) — that is work-state and belongs in the Projects system, never an identity domain. If this is genuinely a durable fact, rephrase it without the ticket/branch/commit/SHA.');
  }
  if (domain === 'skills' && !SKILLS_SLUG_CONTENT_RE.test(content)) {
    throw new Error('skills-domain content must name the exact skill in the shape "Skill \'<slug>\' …" — a row with no quoted skill slug is not about a specific skill artifact and does not belong in this domain.');
  }
}

/**
 * skill_slug is the structural counterpart to the content-regex check above:
 * the column makes "every row about skill X" queryable without parsing
 * prose; the content regex proves the row's own text actually names the
 * skill (defense in depth — a writer could set the column without ever
 * saying the skill's name out loud in content). Required on every
 * skills-domain row, illegal everywhere else — same shape as subject/kind.
 */
function validateSkillSlugForDomain(domain: IdentityDomain, skillSlug: string | null | undefined): void {
  if (domain === 'skills') {
    if (skillSlug == null) {
      throw new Error('skillSlug is required for skills-domain rows — set it to the exact artifact slug (e.g. "pdf-fill") this row is about.');
    }
    return;
  }
  if (skillSlug != null) {
    throw new Error(`skillSlug is only valid in the skills domain (got domain "${ domain }").`);
  }
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
          domain      TEXT        NOT NULL DEFAULT 'human' CHECK (domain IN ('human', 'business', 'world', 'agent', 'environment', 'projects', 'skills')),
          level       SMALLINT    NOT NULL DEFAULT 2 CHECK (level IN (1, 2, 3)),
          category    TEXT,
          content     TEXT        NOT NULL,
          basis       TEXT,
          subject     TEXT,
          evidence    TEXT,
          confidence  REAL,
          kind        TEXT,
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
      await postgresClient.query(`
        ALTER TABLE ${ IdentityObservationsModel.TABLE }
          ADD COLUMN IF NOT EXISTS subject TEXT,
          ADD COLUMN IF NOT EXISTS evidence TEXT,
          ADD COLUMN IF NOT EXISTS confidence REAL,
          ADD COLUMN IF NOT EXISTS kind TEXT,
          ADD COLUMN IF NOT EXISTS skill_slug TEXT
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
    const domain = normalizeIdentityDomain(input.domain);
    const category = normalizeOptionalText(input.category, 'category', MAX_LABEL_CHARS);
    const basis = normalizeOptionalText(input.basis, 'basis', MAX_BASIS_CHARS);
    const subject = normalizeIdentitySubject(input.subject);
    const evidence = normalizeOptionalText(input.evidence, 'evidence', MAX_EVIDENCE_CHARS);
    const confidence = normalizeConfidence(input.confidence);
    const kind = normalizeIdentityKind(input.kind);
    const skillSlug = normalizeSkillSlug(input.skillSlug);
    const source = normalizeOptionalText(input.source, 'source', MAX_SOURCE_CHARS);
    const content = normalizeRequiredText(input.content, 'content', MAX_CONTENT_CHARS);

    validateCategoryForDomain(domain, category);
    validateSubjectForDomain(domain, subject);
    validateKindForDomain(domain, kind);
    validateSkillSlugForDomain(domain, skillSlug);
    validateContentForDomain(domain, content);

    const rows = await postgresClient.query<IdentityObservationRecord>(
      `INSERT INTO ${ IdentityObservationsModel.TABLE } (id, domain, level, category, content, basis, subject, evidence, confidence, kind, skill_slug, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        domain,
        normalizeIdentityLevel(input.level),
        category ?? null,
        content,
        basis ?? null,
        subject ?? null,
        evidence ?? null,
        confidence ?? null,
        kind ?? null,
        skillSlug ?? null,
        source ?? null,
      ],
    );
    return rows[0];
  }

  static async update(id: string, changes: UpdateIdentityObservationInput): Promise<IdentityObservationRecord | null> {
    // The write guards are domain-scoped, but UpdateIdentityObservationInput
    // has no domain field (a row's domain never changes) — fetch it once so
    // category/subject/content changes are validated against the row's own
    // domain, not skipped.
    const existing = await IdentityObservationsModel.getById(id);
    if (!existing) return null;
    const domain = normalizeIdentityDomain(existing.domain);

    const setClauses: string[] = ['updated_at = now()'];
    const values: any[] = [];
    let idx = 1;

    if (changes.level !== undefined) {
      setClauses.push(`level = $${ idx++ }`);
      values.push(normalizeIdentityLevel(changes.level));
    }
    if (changes.category !== undefined) {
      const category = normalizeOptionalText(changes.category, 'category', MAX_LABEL_CHARS);
      validateCategoryForDomain(domain, category);
      setClauses.push(`category = $${ idx++ }`);
      values.push(category);
    }
    if (changes.content !== undefined) {
      const content = normalizeRequiredText(changes.content, 'content', MAX_CONTENT_CHARS);
      validateContentForDomain(domain, content);
      setClauses.push(`content = $${ idx++ }`);
      values.push(content);
    }
    if (changes.basis !== undefined) {
      setClauses.push(`basis = $${ idx++ }`);
      values.push(normalizeOptionalText(changes.basis, 'basis', MAX_BASIS_CHARS));
    }
    if (changes.subject !== undefined) {
      const subject = normalizeIdentitySubject(changes.subject);
      validateSubjectForDomain(domain, subject);
      setClauses.push(`subject = $${ idx++ }`);
      values.push(subject);
    }
    if (changes.evidence !== undefined) {
      setClauses.push(`evidence = $${ idx++ }`);
      values.push(normalizeOptionalText(changes.evidence, 'evidence', MAX_EVIDENCE_CHARS));
    }
    if (changes.confidence !== undefined) {
      setClauses.push(`confidence = $${ idx++ }`);
      values.push(normalizeConfidence(changes.confidence));
    }
    if (changes.kind !== undefined) {
      const kind = normalizeIdentityKind(changes.kind);
      validateKindForDomain(domain, kind);
      setClauses.push(`kind = $${ idx++ }`);
      values.push(kind);
    }
    if (changes.skillSlug !== undefined) {
      const skillSlug = normalizeSkillSlug(changes.skillSlug);
      validateSkillSlugForDomain(domain, skillSlug);
      setClauses.push(`skill_slug = $${ idx++ }`);
      values.push(skillSlug);
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
   * domain (exact normalised match or substring containment). Deliberately
   * bypasses listActive's public MAX_LIST_LIMIT (100) via MAX_DEDUP_SCAN
   * (500) — dedup must cover the whole domain, not just the page a human/
   * tool would want back. Previously called listActive(domain, {limit: 500}),
   * but listActive clamps to MAX_LIST_LIMIT=100, so any domain past 100
   * active rows was silently dedup-checked against only its newest/highest-
   * certainty 100 — exactly the polluted regime (human hit 70, agent hit 52)
   * where duplication matters most.
   */
  static async findDuplicate(domain: string, content: string): Promise<IdentityObservationRecord | null> {
    const normalizedDomain = normalizeIdentityDomain(domain);
    const normalise = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const norm = normalise(normalizeRequiredText(content, 'content', MAX_CONTENT_CHARS));

    const rows = await postgresClient.query<IdentityObservationRecord>(
      `SELECT * FROM ${ IdentityObservationsModel.TABLE }
       WHERE archived = false AND domain = $1
       ORDER BY level DESC, created_at DESC
       LIMIT $2`,
      [normalizedDomain, MAX_DEDUP_SCAN],
    );

    for (const row of rows) {
      const existing = normalise(row.content);
      if (existing === norm) return row;
      if (existing.includes(norm) || norm.includes(existing)) return row;
    }
    return null;
  }

  /**
   * Cheap row count for the recall-dispatch row-count gate (see
   * SubconsciousMiddleware's SQL fast-path): 0 active rows means skip the
   * search entirely; a small count means inject listActive() directly
   * without spinning up a blocking LLM subagent to search almost nothing.
   */
  static async countActive(domain: string): Promise<number> {
    const normalizedDomain = normalizeIdentityDomain(domain);
    const rows = await postgresClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${ IdentityObservationsModel.TABLE }
       WHERE archived = false AND domain = $1`,
      [normalizedDomain],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
