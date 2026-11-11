// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { describe, expect, it } from 'vitest';
import { PostgresUseCaseCatalogSource } from '../../../useCases/PostgresUseCaseCatalogSource';

describe('PostgresUseCaseCatalogSource publication filters', () => {
  it('queries narrow published-only projections for every catalog type', async () => {
    // risk: permissions — SQL filters prevent drafts and disabled definitions entering agent context.
    const sql: string[] = [];
    const db = { async query<T>(statement: string): Promise<T[]> { sql.push(statement); return []; } };
    const source = new PostgresUseCaseCatalogSource(db, ['bundled-skill']);
    await source.listPublished();
    expect(sql).toHaveLength(5);
    expect(sql[0]).toContain('enabled=true AND deleted_at IS NULL AND (use_case_version_id IS NOT NULL OR slug = ANY');
    expect(sql[1]).toContain("enabled=true AND status='production'");
    expect(sql[2]).toContain("enabled=true AND status='production'");
    expect(sql[3]).toContain('enabled=true AND use_case_version_id IS NOT NULL');
    expect(sql[4]).toContain("r.enabled=true AND EXISTS (SELECT 1 FROM installed_package_items");
    expect(sql.every(statement => !/SELECT\s+\*/i.test(statement))).toBe(true);
  });
  it('returns only published declared workflow and recipe inputs, excluding credential-like fields', async () => {
    // risk: permissions — suggestions may expose editable fields, never secret inputs or credentials.
    const db = { async query<T>(sql: string): Promise<T[]> {
      if (sql.includes('FROM workflows')) return [{ id: 'workflow-a', name: 'Workflow', description: 'desc', definition: { inputs: { city: { type: 'string', required: true, description: 'Target city' }, api_key: { type: 'string', default: 'secret' } } } }] as T[];
      if (sql.includes('FROM recipe_definitions')) return [{ slug: 'recipe-a', name: 'Recipe', description: 'desc', manifest: { spec: { inputs: { region: { type: 'boolean', default: true }, password: { type: 'string', default: 'secret' } } } } }] as T[];
      return [];
    } };
    const items = await new PostgresUseCaseCatalogSource(db).listPublished();
    expect(items.find(item => item.slug === 'workflow-a')?.inputs).toEqual([{ name: 'city', type: 'string', required: true, description: 'Target city' }]);
    expect(items.find(item => item.slug === 'recipe-a')?.inputs).toEqual([{ name: 'region', type: 'boolean', required: false, default: true }]);
  });
  it('re-reads only the changed item with publication constraints', async () => {
    // risk: data accuracy — updates/removals must not rebuild from stale or unpublished rows.
    let statement = '';
    const db = { async query<T>(sql: string): Promise<T[]> { statement = sql; return []; } };
    expect(await new PostgresUseCaseCatalogSource(db).findPublished('agent', 'draft-agent')).toBeNull();
    expect(statement).toContain("slug=$1 AND enabled=true AND status='production'");
  });
});
