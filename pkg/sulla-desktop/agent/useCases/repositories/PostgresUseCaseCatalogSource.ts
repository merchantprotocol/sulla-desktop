// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { UseCaseCatalogItem, UseCaseCatalogSource, UseCaseInput, UseCaseType } from '../UseCaseSuggestionIndex';

export interface SuggestionSqlClient { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> }

/**
 * Published-only filters, shared by the full list, the single-row re-read and
 * the change fingerprint so all three always agree on what "published" means.
 * `$1` is always the bundled-skill slug list.
 */
const PUBLISHED = {
  skill:    `FROM skill_definitions WHERE enabled=true AND deleted_at IS NULL AND (use_case_version_id IS NOT NULL OR slug = ANY($1::text[]))`,
  agent:    `FROM agent_definitions WHERE enabled=true AND status='production'`,
  workflow: `FROM workflows WHERE enabled=true AND status='production'`,
  // Functions and recipes are active when published through Sulla Files (use_case_version_id) or
  // installed from the marketplace (which only serves published releases). User rows without a
  // published version are drafts.
  function: `FROM function_definitions f WHERE f.enabled=true AND (f.use_case_version_id IS NOT NULL OR f.source_kind='marketplace' OR EXISTS (SELECT 1 FROM installed_package_items i WHERE i.kind='function' AND i.item_slug=f.slug))`,
  recipe:   `FROM recipe_definitions r WHERE r.enabled=true AND (r.use_case_version_id IS NOT NULL OR r.source_kind='marketplace' OR EXISTS (SELECT 1 FROM installed_package_items i WHERE i.kind='recipe' AND i.item_slug=r.slug))`,
} as const;

const COLUMNS: Record<UseCaseType, { key: string; select: string; content: string }> = {
  skill:    { key: 'slug', select: `slug,title,description,tags,triggers`, content: `COALESCE(title,'')||'|'||COALESCE(description,'')||'|'||COALESCE(tags::text,'')||'|'||COALESCE(triggers::text,'')` },
  agent:    { key: 'slug', select: `slug,name,description,when_to_call`, content: `COALESCE(name,'')||'|'||COALESCE(description,'')||'|'||COALESCE(when_to_call::text,'')` },
  // Only spec.inputs leaves the database: the rest of a routine definition can carry node config.
  workflow: { key: 'id', select: `id AS slug,name,description,definition->'spec'->'inputs' AS inputs`, content: `COALESCE(name,'')||'|'||COALESCE(description,'')||'|'||COALESCE((definition->'spec'->'inputs')::text,'')` },
  function: { key: 'f.slug', select: `f.slug,f.name,f.description,f.manifest->'spec'->'inputs' AS inputs`, content: `COALESCE(f.name,'')||'|'||COALESCE(f.description,'')||'|'||COALESCE((f.manifest->'spec'->'inputs')::text,'')` },
  // A recipe's installation.yaml (InstallationManifest) declares no user inputs; its env and
  // integrations blocks carry credential templates, so nothing from the manifest is read.
  recipe:   { key: 'r.slug', select: `r.slug,r.name,r.description`, content: `COALESCE(r.name,'')||'|'||COALESCE(r.description,'')` },
};

const TYPES: readonly UseCaseType[] = ['skill', 'agent', 'workflow', 'function', 'recipe'];
const SECRET_NAME = /secret|passw(or)?d|token|credential|api[_ -]?key|private[_ -]?key|auth|access[_ -]?key|session|cookie/i;
const INPUT_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const MAX_INPUTS = 32;
const MAX_LABEL = 120;

/**
 * Narrow SQL projections over published, enabled definitions; drafts never
 * enter process memory or agent context.
 */
export class PostgresUseCaseCatalogSource implements UseCaseCatalogSource {
  constructor(private readonly db: SuggestionSqlClient, private readonly builtinSkillSlugs: readonly string[] = []) {}

  async listPublished(): Promise<UseCaseCatalogItem[]> {
    const items: UseCaseCatalogItem[] = [];
    for (const type of TYPES) {
      const rows = await this.db.query<any>(`SELECT ${ COLUMNS[type].select } ${ PUBLISHED[type] }`, this.params(type, []));
      for (const row of rows) items.push(this.item(type, row));
    }
    return items;
  }

  async findPublished(type: UseCaseType, slug: string): Promise<UseCaseCatalogItem | null> {
    const keyParam = type === 'skill' ? '$2' : '$1';
    const rows = await this.db.query<any>(`SELECT ${ COLUMNS[type].select } ${ PUBLISHED[type] } AND ${ COLUMNS[type].key }=${ keyParam }`, this.params(type, [slug]));
    return rows[0] ? this.item(type, rows[0]) : null;
  }

  /**
   * One cheap hash over every published row's indexed content. Any create,
   * update, publish, disable or delete — through any code path — changes it,
   * so the index can reconcile writes that never emitted a change event.
   */
  async fingerprint(): Promise<string> {
    const parts = TYPES.map(type => `SELECT '${ type }:'||${ COLUMNS[type].key }||':'||md5(${ COLUMNS[type].content }) AS k ${ PUBLISHED[type] }`);
    const rows = await this.db.query<{ fp: string | null }>(`SELECT COALESCE(md5(string_agg(k, ',' ORDER BY k)), 'empty') AS fp FROM (${ parts.join(' UNION ALL ') }) published`, [this.builtinSkillSlugs]);
    return String(rows[0]?.fp ?? 'empty');
  }

  private params(type: UseCaseType, extra: unknown[]): unknown[] {
    return type === 'skill' ? [this.builtinSkillSlugs, ...extra] : extra;
  }

  private item(type: UseCaseType, row: any): UseCaseCatalogItem {
    const triggers = row.triggers ?? row.when_to_call;
    const item: UseCaseCatalogItem = {
      type,
      slug:        String(row.slug),
      title:       String(row.title ?? row.name ?? row.slug),
      description: String(row.description ?? ''),
      triggers:    Array.isArray(triggers) ? triggers.map(String) : triggers ? [String(triggers)] : [],
      tags:        Array.isArray(row.tags) ? row.tags.map(String) : [],
    };
    const inputs = this.declaredInputs(row.inputs);
    if (inputs.length) item.inputs = inputs;
    return item;
  }

  /**
   * Declared input fields as `{ name, label?, required? }` only. Values,
   * defaults, examples, patterns and descriptions are never copied, and
   * credential-like fields are dropped entirely.
   */
  private declaredInputs(value: unknown): UseCaseInput[] {
    const schema = typeof value === 'string' ? this.parseJson(value) : value;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
    const inputs: UseCaseInput[] = [];
    for (const [name, raw] of Object.entries(schema as Record<string, unknown>)) {
      if (inputs.length >= MAX_INPUTS) break;
      if (!INPUT_NAME.test(name) || SECRET_NAME.test(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const field = raw as Record<string, unknown>;
      if (field.secret === true || field.sensitive === true || field.format === 'password') continue;
      const input: UseCaseInput = { name };
      const label = typeof field.label === 'string' ? field.label : typeof field.title === 'string' ? field.title : undefined;
      if (label?.trim() && !SECRET_NAME.test(label)) input.label = label.trim().slice(0, MAX_LABEL);
      if (field.required === true) input.required = true;
      inputs.push(input);
    }
    return inputs;
  }

  private parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }
}
