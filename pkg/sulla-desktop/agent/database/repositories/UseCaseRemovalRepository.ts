// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface UseCaseRemovalSqlClient { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> }
export interface RemovedUseCase { type: string; slug: string }

/** Finds the Files-backed definitions that are about to be disabled because their package is no longer active. */
export class UseCaseRemovalRepository {
  constructor(private readonly db: UseCaseRemovalSqlClient) {}

  /** `active` holds `<type>/<slug>` keys. A failed read returns [] (the index's reconcile repairs the miss). */
  async listRemoved(active: ReadonlySet<string>): Promise<RemovedUseCase[]> {
    const slugs = (prefix: string): string[] => [...active].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
    return this.db.query<RemovedUseCase>(`SELECT 'agent' AS type,slug FROM agent_definitions WHERE use_case_file_id IS NOT NULL AND enabled=TRUE AND NOT (slug=ANY($1::text[])) UNION ALL SELECT 'skill',slug FROM skill_definitions WHERE use_case_file_id IS NOT NULL AND enabled=TRUE AND deleted_at IS NULL AND NOT (slug=ANY($2::text[])) UNION ALL SELECT 'workflow',id FROM workflows WHERE use_case_file_id IS NOT NULL AND enabled=TRUE AND NOT (id=ANY($3::text[])) UNION ALL SELECT 'function',slug FROM function_definitions WHERE use_case_file_id IS NOT NULL AND enabled=TRUE AND NOT (slug=ANY($4::text[])) UNION ALL SELECT 'recipe',slug FROM recipe_definitions WHERE use_case_file_id IS NOT NULL AND enabled=TRUE AND NOT (slug=ANY($5::text[]))`, [slugs('agents/'), slugs('skills/'), slugs('workflows/'), slugs('functions/'), slugs('recipes/')])
      .catch((): RemovedUseCase[] => []);
  }
}
