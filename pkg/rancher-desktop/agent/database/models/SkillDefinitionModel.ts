import { randomUUID } from 'node:crypto';

import { postgresClient } from '../PostgresClient';

export type SkillSourceKind = 'builtin' | 'user' | 'marketplace' | 'resources';

export const SKILL_SOURCE_KINDS: readonly SkillSourceKind[] = ['builtin', 'user', 'marketplace', 'resources'];

/** A non-SKILL.md file of a skill folder: text as-is, binaries as base64. */
export type SkillFile = string | { encoding: 'base64'; content: string };

export interface SkillDefinition {
  id:                      string;
  slug:                    string;
  title:                   string;
  description:             string;
  tags:                    string[];
  triggers:                string[];
  /** Markdown after the frontmatter. */
  body:                    string;
  /** Parsed frontmatter, as written in SKILL.md. */
  frontmatter:             Record<string, unknown>;
  /** Exact frontmatter text, so the row renders back to its SKILL.md. */
  frontmatter_text:        string;
  /** Other files of the skill folder, keyed by relative path. */
  files:                   Record<string, SkillFile>;
  version:                 string | null;
  source_kind:             SkillSourceKind;
  /** Folder this row was imported from, if any. Informational only. */
  source_path:             string | null;
  /** Hash of the content the last seeder/importer wrote. */
  source_hash:             string | null;
  enabled:                 boolean;
  /** Soft delete. A deleted row is hidden and its slug is never re-imported. */
  deleted_at:              string | null;
  content_hash:            string | null;
  marketplace_template_id: string | null;
  marketplace_slug:        string | null;
  marketplace_version:     string | null;
  marketplace_author:      string | null;
  created_at:              string;
  updated_at:              string;
}

/** The content columns of a skill. Everything else is bookkeeping. */
export interface SkillContent {
  title:            string;
  description:      string;
  tags:             string[];
  triggers:         string[];
  body:             string;
  frontmatter:      Record<string, unknown>;
  frontmatter_text: string;
  files:            Record<string, SkillFile>;
  version:          string | null;
}

export interface SkillDefinitionInput extends SkillContent {
  slug:                   string;
  sourceKind?:            SkillSourceKind;
  sourcePath?:            string | null;
  sourceHash?:            string | null;
  enabled?:               boolean;
  contentHash?:           string | null;
  marketplaceTemplateId?: string | null;
  marketplaceSlug?:       string | null;
  marketplaceVersion?:    string | null;
  marketplaceAuthor?:     string | null;
}

export interface SkillDefinitionPatch extends Partial<SkillContent> {
  sourceKind?:            SkillSourceKind;
  sourcePath?:            string | null;
  sourceHash?:            string | null;
  enabled?:               boolean;
  deleted?:               boolean;
  contentHash?:           string | null;
  marketplaceTemplateId?: string | null;
  marketplaceSlug?:       string | null;
  marketplaceVersion?:    string | null;
  marketplaceAuthor?:     string | null;
}

export interface SkillListOptions {
  includeDisabled?: boolean;
  includeDeleted?:  boolean;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
}

function toObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function toNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toSourceKind(value: unknown): SkillSourceKind {
  return (SKILL_SOURCE_KINDS as readonly string[]).includes(String(value)) ? value as SkillSourceKind : 'user';
}

export function rowToSkillDefinition(row: any): SkillDefinition {
  return {
    id:                      String(row.id),
    slug:                    String(row.slug),
    title:                   String(row.title),
    description:             String(row.description ?? ''),
    tags:                    toStringArray(row.tags),
    triggers:                toStringArray(row.triggers),
    body:                    String(row.body ?? ''),
    frontmatter:             toObject(row.frontmatter),
    frontmatter_text:        String(row.frontmatter_text ?? ''),
    files:                   toObject(row.files) as Record<string, SkillFile>,
    version:                 toNullableString(row.version),
    source_kind:             toSourceKind(row.source_kind),
    source_path:             toNullableString(row.source_path),
    source_hash:             toNullableString(row.source_hash),
    enabled:                 row.enabled !== false,
    deleted_at:              row.deleted_at == null ? null : toIso(row.deleted_at),
    content_hash:            toNullableString(row.content_hash),
    marketplace_template_id: toNullableString(row.marketplace_template_id),
    marketplace_slug:        toNullableString(row.marketplace_slug),
    marketplace_version:     toNullableString(row.marketplace_version),
    marketplace_author:      toNullableString(row.marketplace_author),
    created_at:              toIso(row.created_at),
    updated_at:              toIso(row.updated_at),
  };
}

function required(value: string, field: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${ field } is required.`);
  return normalized;
}

export class SkillDefinitionModel {
  /** Finds a row by slug, including disabled and soft-deleted rows. */
  static async findBySlug(slug: string): Promise<SkillDefinition | null> {
    const row = await postgresClient.queryOne('SELECT * FROM skill_definitions WHERE slug = $1 LIMIT 1', [slug]);
    return row ? rowToSkillDefinition(row) : null;
  }

  static async list(options: SkillListOptions = {}): Promise<SkillDefinition[]> {
    const where: string[] = [];
    if (!options.includeDeleted) where.push('deleted_at IS NULL');
    if (!options.includeDisabled) where.push('enabled = true');
    const rows = await postgresClient.query(
      `SELECT * FROM skill_definitions ${ where.length ? `WHERE ${ where.join(' AND ') }` : '' } ORDER BY slug ASC`,
      [],
    );
    return rows.map(rowToSkillDefinition);
  }

  /** Every slug the table holds, deleted ones included. */
  static async listSlugs(): Promise<Set<string>> {
    const rows = await postgresClient.query('SELECT slug FROM skill_definitions', []);
    return new Set(rows.map((row: { slug: string }) => String(row.slug)));
  }

  static async create(input: SkillDefinitionInput): Promise<SkillDefinition> {
    const slug = required(input.slug, 'slug');
    const title = required(input.title, 'title');
    const row = await postgresClient.queryOne(`
      INSERT INTO skill_definitions (
        id, slug, title, description, tags, triggers, body, frontmatter, frontmatter_text, files, version,
        source_kind, source_path, source_hash, enabled, content_hash,
        marketplace_template_id, marketplace_slug, marketplace_version, marketplace_author
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *
    `, [
      `skill-${ randomUUID() }`, slug, title, input.description ?? '', toStringArray(input.tags), toStringArray(input.triggers),
      input.body ?? '', JSON.stringify(input.frontmatter ?? {}), input.frontmatter_text ?? '', JSON.stringify(input.files ?? {}),
      input.version ?? null, input.sourceKind ?? 'user', input.sourcePath ?? null, input.sourceHash ?? null,
      input.enabled !== false, input.contentHash ?? null,
      input.marketplaceTemplateId ?? null, input.marketplaceSlug ?? null, input.marketplaceVersion ?? null, input.marketplaceAuthor ?? null,
    ]);
    if (!row) throw new Error(`Failed to create skill ${ slug }.`);
    return rowToSkillDefinition(row);
  }

  /**
   * Apply a patch. When expectedUpdatedAt is given the write only lands if the
   * row has not changed since it was read (compare-and-set on updated_at);
   * otherwise null is returned and nothing is written.
   */
  static async update(id: string, patch: SkillDefinitionPatch, expectedUpdatedAt?: string): Promise<SkillDefinition | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown, cast = '') => {
      sets.push(`${ column } = $${ params.length + 1 }${ cast }`);
      params.push(value);
    };
    if (patch.title !== undefined) add('title', required(patch.title, 'title'));
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.tags !== undefined) add('tags', toStringArray(patch.tags));
    if (patch.triggers !== undefined) add('triggers', toStringArray(patch.triggers));
    if (patch.body !== undefined) add('body', patch.body);
    if (patch.frontmatter !== undefined) add('frontmatter', JSON.stringify(patch.frontmatter), '::jsonb');
    if (patch.frontmatter_text !== undefined) add('frontmatter_text', patch.frontmatter_text);
    if (patch.files !== undefined) add('files', JSON.stringify(patch.files), '::jsonb');
    if (patch.version !== undefined) add('version', patch.version);
    if (patch.sourceKind !== undefined) add('source_kind', patch.sourceKind);
    if (patch.sourcePath !== undefined) add('source_path', patch.sourcePath);
    if (patch.sourceHash !== undefined) add('source_hash', patch.sourceHash);
    if (patch.enabled !== undefined) add('enabled', patch.enabled);
    if (patch.deleted !== undefined) sets.push(patch.deleted ? 'deleted_at = COALESCE(deleted_at, now())' : 'deleted_at = NULL');
    if (patch.contentHash !== undefined) add('content_hash', patch.contentHash);
    if (patch.marketplaceTemplateId !== undefined) add('marketplace_template_id', patch.marketplaceTemplateId);
    if (patch.marketplaceSlug !== undefined) add('marketplace_slug', patch.marketplaceSlug);
    if (patch.marketplaceVersion !== undefined) add('marketplace_version', patch.marketplaceVersion);
    if (patch.marketplaceAuthor !== undefined) add('marketplace_author', patch.marketplaceAuthor);
    if (sets.length === 0) {
      const row = await postgresClient.queryOne('SELECT * FROM skill_definitions WHERE id = $1 LIMIT 1', [id]);
      return row ? rowToSkillDefinition(row) : null;
    }
    sets.push('updated_at = now()');
    params.push(id);
    let where = `id = $${ params.length }`;
    if (expectedUpdatedAt) {
      params.push(expectedUpdatedAt);
      // JS dates carry ms only; allow for the dropped microseconds.
      where += ` AND abs(extract(epoch FROM updated_at - $${ params.length }::timestamptz)) < 0.002`;
    }
    const row = await postgresClient.queryOne(`UPDATE skill_definitions SET ${ sets.join(', ') } WHERE ${ where } RETURNING *`, params);
    return row ? rowToSkillDefinition(row) : null;
  }

  /** Text search over the active skills: slug, title, description, tags, triggers and body. */
  static async search(query: string, limit = 20): Promise<SkillDefinition[]> {
    const terms = String(query ?? '').toLowerCase().split(/\s+/).map(term => term.trim()).filter(term => term.length > 1).slice(0, 8);
    if (!terms.length) return [];
    const params: unknown[] = [];
    const clauses = terms.map((term) => {
      params.push(`%${ term.replace(/[\\%_]/g, char => `\\${ char }`) }%`);
      const p = `$${ params.length }`;
      return `(slug ILIKE ${ p } OR title ILIKE ${ p } OR description ILIKE ${ p } OR array_to_string(tags, ' ') ILIKE ${ p } OR array_to_string(triggers, ' ') ILIKE ${ p } OR body ILIKE ${ p })`;
    });
    // Any term matches; rows matching more terms (and in the title) rank first.
    const score = terms.map((_, i) => `(CASE WHEN title ILIKE $${ i + 1 } OR slug ILIKE $${ i + 1 } THEN 2 ELSE 0 END + CASE WHEN ${ clauses[i] } THEN 1 ELSE 0 END)`).join(' + ');
    params.push(Math.max(1, Math.min(100, limit)));
    const rows = await postgresClient.query(`
      SELECT *, (${ score }) AS score FROM skill_definitions
      WHERE deleted_at IS NULL AND enabled = true AND (${ clauses.join(' OR ') })
      ORDER BY score DESC, slug ASC LIMIT $${ params.length }
    `, params);
    return rows.map(rowToSkillDefinition);
  }
}
