/**
 * LibraryDraftModel — polymorphic store for editable copies of library
 * items (skills, functions, recipes) forked from ~/sulla/<kind>s/<slug>/.
 *
 * Why a DB and not file-on-disk edits:
 *   - The original bundle on disk stays pristine while the user
 *     experiments. That means nothing gets silently broken when a user
 *     abandons an edit session.
 *   - Drafts are addressable by id (not slug), so a user can have
 *     multiple in-flight forks of the same base item.
 *   - Publishing is a distinct commit step that either materialises the
 *     draft back to disk or submits it to the marketplace.
 *
 * One row per draft, polymorphic by `kind`. See the migration at
 * `migrations/0025_create_library_drafts_table.ts` for the schema.
 */

import { postgresClient } from '../PostgresClient';

export type LibraryDraftKind = 'skill' | 'function' | 'recipe';

export interface LibraryDraft {
  id:             string;
  kind:           LibraryDraftKind;
  slug:           string;
  base_slug:      string | null;
  name:           string;
  manifest_json:  Record<string, unknown>;
  files_json:     Record<string, string>;
  created_at:     string;
  updated_at:     string;
}

export interface LibraryDraftSummary {
  id:         string;
  kind:       LibraryDraftKind;
  slug:       string;
  base_slug:  string | null;
  name:       string;
  updated_at: string;
}

function rowToDraft(row: any): LibraryDraft {
  return {
    id:            row.id,
    kind:          row.kind,
    slug:          row.slug,
    base_slug:     row.base_slug ?? null,
    name:          row.name,
    manifest_json: coerceObject(row.manifest_json),
    files_json:    coerceStringMap(row.files_json),
    created_at:    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
    updated_at:    row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
  };
}

function rowToSummary(row: any): LibraryDraftSummary {
  return {
    id:         row.id,
    kind:       row.kind,
    slug:       row.slug,
    base_slug:  row.base_slug ?? null,
    name:       row.name,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
  };
}

function coerceObject(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === 'object') return v as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(v));

    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function coerceStringMap(v: unknown): Record<string, string> {
  const obj = coerceObject(v);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj)) out[k] = String(val ?? '');

  return out;
}

function generateId(): string {
  return `draft_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 10) }`;
}

export class LibraryDraftModel {
  /** Create a new draft row. Returns the inserted draft with fresh timestamps. */
  static async create(input: {
    kind:          LibraryDraftKind;
    slug:          string;
    base_slug?:    string | null;
    name:          string;
    manifest_json: Record<string, unknown>;
    files_json?:   Record<string, string>;
  }): Promise<LibraryDraft> {
    const id = generateId();
    const row = await postgresClient.queryOne(
      `INSERT INTO library_drafts (id, kind, slug, base_slug, name, manifest_json, files_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING *`,
      [
        id,
        input.kind,
        input.slug,
        input.base_slug ?? null,
        input.name,
        JSON.stringify(input.manifest_json),
        JSON.stringify(input.files_json ?? {}),
      ],
    );

    return rowToDraft(row);
  }

  static async findById(id: string): Promise<LibraryDraft | null> {
    const row = await postgresClient.queryOne(
      'SELECT * FROM library_drafts WHERE id = $1 LIMIT 1',
      [id],
    );

    return row ? rowToDraft(row) : null;
  }

  static async listAll(kind?: LibraryDraftKind): Promise<LibraryDraftSummary[]> {
    const rows = kind
      ? await postgresClient.queryAll(
        'SELECT id, kind, slug, base_slug, name, updated_at FROM library_drafts WHERE kind = $1 ORDER BY updated_at DESC',
        [kind],
      )
      : await postgresClient.queryAll(
        'SELECT id, kind, slug, base_slug, name, updated_at FROM library_drafts ORDER BY updated_at DESC',
        [],
      );

    return rows.map(rowToSummary);
  }

  /** Patch one or more fields on a draft. Keys absent from `patch` are left alone. */
  static async update(
    id: string,
    patch: {
      slug?:          string;
      name?:          string;
      manifest_json?: Record<string, unknown>;
      files_json?:    Record<string, string>;
    },
  ): Promise<LibraryDraft | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (patch.slug !== undefined)          { sets.push(`slug = $${ i++ }`);               params.push(patch.slug); }
    if (patch.name !== undefined)          { sets.push(`name = $${ i++ }`);               params.push(patch.name); }
    if (patch.manifest_json !== undefined) { sets.push(`manifest_json = $${ i++ }::jsonb`); params.push(JSON.stringify(patch.manifest_json)); }
    if (patch.files_json !== undefined)    { sets.push(`files_json = $${ i++ }::jsonb`);    params.push(JSON.stringify(patch.files_json)); }

    if (sets.length === 0) {
      return LibraryDraftModel.findById(id);
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const row = await postgresClient.queryOne(
      `UPDATE library_drafts SET ${ sets.join(', ') } WHERE id = $${ i } RETURNING *`,
      params,
    );

    return row ? rowToDraft(row) : null;
  }

  static async delete(id: string): Promise<boolean> {
    const row = await postgresClient.queryOne(
      'DELETE FROM library_drafts WHERE id = $1 RETURNING id',
      [id],
    );

    return !!row;
  }
}
