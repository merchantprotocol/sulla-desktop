// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { UseCaseCatalogItem, UseCaseCatalogSource, UseCaseInput, UseCaseType } from './UseCaseSuggestionIndex';

export interface SuggestionSqlClient { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> }

/** Narrow SQL projections; excluded drafts never enter process memory or context. */
export class PostgresUseCaseCatalogSource implements UseCaseCatalogSource {
  constructor(private readonly db: SuggestionSqlClient, private readonly builtinSkillSlugs: readonly string[] = []) {}
  async listPublished(): Promise<UseCaseCatalogItem[]> {
    const skillRows = await this.db.query<any>(`SELECT slug,title,description,tags,triggers FROM skill_definitions WHERE enabled=true AND deleted_at IS NULL AND (use_case_version_id IS NOT NULL OR slug = ANY($1::text[]))`, [this.builtinSkillSlugs]);
    const agents = await this.db.query<any>(`SELECT slug,name,description,when_to_call FROM agent_definitions WHERE enabled=true AND status='production'`);
    const workflows = await this.db.query<any>(`SELECT id,name,description,definition FROM workflows WHERE enabled=true AND status='production'`);
    const functions = await this.db.query<any>(`SELECT slug,name,description FROM function_definitions WHERE enabled=true AND use_case_version_id IS NOT NULL`);
    const recipes = await this.db.query<any>(`SELECT r.slug,r.name,r.description,r.manifest FROM recipe_definitions r WHERE r.enabled=true AND EXISTS (SELECT 1 FROM installed_package_items i WHERE i.kind='recipe' AND i.item_slug=r.slug)`);
    return [
      ...skillRows.map((r: any) => this.item('skill', r.slug, r.title, r.description, r.triggers, r.tags)),
      ...agents.map((r: any) => this.item('agent', r.slug, r.name, r.description, [r.when_to_call])),
      ...workflows.map((r: any) => this.item('workflow', r.id, r.name, r.description, undefined, undefined, this.declaredInputs(r.definition?.inputs))),
      ...functions.map((r: any) => this.item('function', r.slug, r.name, r.description)),
      ...recipes.map((r: any) => this.item('recipe', r.slug, r.name, r.description, undefined, undefined, this.declaredInputs(r.manifest?.spec?.inputs))),
    ];
  }
  async findPublished(type: UseCaseType, slug: string): Promise<UseCaseCatalogItem | null> {
    const queries: Record<UseCaseType, [string, unknown[]]> = {
      skill: [`SELECT slug,title,description,tags,triggers FROM skill_definitions WHERE slug=$1 AND enabled=true AND deleted_at IS NULL AND (use_case_version_id IS NOT NULL OR slug = ANY($2::text[]))`, [slug, this.builtinSkillSlugs]],
      agent: [`SELECT slug,name,description,when_to_call FROM agent_definitions WHERE slug=$1 AND enabled=true AND status='production'`, [slug]],
      workflow: [`SELECT id AS slug,name,description,definition FROM workflows WHERE id=$1 AND enabled=true AND status='production'`, [slug]],
      function: [`SELECT slug,name,description FROM function_definitions WHERE slug=$1 AND enabled=true AND use_case_version_id IS NOT NULL`, [slug]],
      recipe: [`SELECT r.slug,r.name,r.description,r.manifest FROM recipe_definitions r WHERE r.slug=$1 AND r.enabled=true AND EXISTS (SELECT 1 FROM installed_package_items i WHERE i.kind='recipe' AND i.item_slug=r.slug)`, [slug]],
    };
    const row = (await this.db.query<any>(...queries[type]))[0];
    if (!row) return null;
    return this.item(type, row.slug, row.title ?? row.name, row.description, row.triggers ?? row.when_to_call, row.tags, type === 'workflow' ? this.declaredInputs(row.definition?.inputs) : type === 'recipe' ? this.declaredInputs(row.manifest?.spec?.inputs) : undefined);
  }
  private item(type: UseCaseType, slug: string, title: string, description: string, triggers?: unknown, tags?: unknown, inputs?: UseCaseInput[]): UseCaseCatalogItem {
    return { type, slug: String(slug), title: String(title ?? slug), description: String(description ?? ''), triggers: Array.isArray(triggers) ? triggers.map(String) : triggers ? [String(triggers)] : [], tags: Array.isArray(tags) ? tags.map(String) : [], ...(inputs?.length ? { inputs } : {}) };
  }
  /** Read only explicit published input declarations; never propagate credential-like defaults. */
  private declaredInputs(value: unknown): UseCaseInput[] | undefined {
    const schema = typeof value === 'string' ? this.parseJson(value) : value;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
    const blocked = /secret|password|token|credential|api[_ -]?key|private[_ -]?key|authorization|access[_ -]?key/i;
    const inputs: UseCaseInput[] = [];
    for (const [name, raw] of Object.entries(schema as Record<string, unknown>)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name) || blocked.test(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const field = raw as Record<string, unknown>;
      if (typeof field.type !== 'string' || blocked.test(String(field.description ?? ''))) continue;
      const input: UseCaseInput = { name, type: field.type, required: field.required === true };
      if (typeof field.description === 'string') input.description = field.description;
      const fallback = field.default;
      if (typeof fallback === 'boolean' || typeof fallback === 'number' || fallback === null) input.default = fallback;
      inputs.push(input);
    }
    return inputs.length ? inputs : undefined;
  }
  private parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }
}
