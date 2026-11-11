// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { describe, expect, it } from 'vitest';
import { PostgresUseCaseCatalogSource } from '../../../useCases/repositories/PostgresUseCaseCatalogSource';

/** Returns rows per table; records every statement and its params. */
class FakeDb {
  readonly calls: { sql: string; params?: unknown[] }[] = [];
  constructor(private readonly tables: Record<string, any[]> = {}) {}
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.calls.push({ sql, params });
    const table = Object.keys(this.tables).find(name => sql.includes(`FROM ${ name }`));
    return (table ? this.tables[table] : []) as T[];
  }
}

describe('PostgresUseCaseCatalogSource', () => {
  it('only reads published, enabled rows and never selects whole definitions', async() => {
    // risk: permissions — drafts and disabled definitions must never enter agent context.
    const db = new FakeDb();
    await new PostgresUseCaseCatalogSource(db, ['bundled-skill']).listPublished();
    const byTable = (name: string) => db.calls.find(call => call.sql.includes(`FROM ${ name }`))!;
    expect(byTable('skill_definitions').sql).toContain('enabled=true AND deleted_at IS NULL AND (use_case_version_id IS NOT NULL OR slug = ANY($1::text[]))');
    expect(byTable('skill_definitions').params).toEqual([['bundled-skill']]);
    expect(byTable('agent_definitions').sql).toContain("enabled=true AND status='production'");
    expect(byTable('workflows').sql).toContain("enabled=true AND status='production'");
    // Files-published (use_case_version_id) and marketplace-installed functions/recipes are active; bare user rows are drafts.
    expect(byTable('function_definitions').sql).toContain("f.enabled=true AND (f.use_case_version_id IS NOT NULL OR f.source_kind='marketplace'");
    expect(byTable('recipe_definitions').sql).toContain("r.enabled=true AND (r.use_case_version_id IS NOT NULL OR r.source_kind='marketplace'");
    expect(db.calls.every(call => !/SELECT\s+\*|,definition[,\s]|,manifest[,\s]/i.test(call.sql))).toBe(true);
  });

  it('exposes declared workflow and function inputs as name/label/required only, never values or credentials', async() => {
    // risk: permissions — suggestions reach the renderer; defaults can hold credentials and must never be copied.
    const db = new FakeDb({
      workflows: [{ slug: 'fetch-invoice', name: 'Fetch invoice', description: 'd', inputs: {
        invoice_id:   { type: 'string', required: true, label: 'Invoice ID', pattern: '^in_', description: 'Stripe invoice' },
        include_more: { type: 'boolean', default: true },
        api_key:      { type: 'string', default: 'sk_live_123' },
        webhook:      { type: 'string', secret: true, default: 'whsec_1' },
        'bad name':   { type: 'string' },
      } }],
      function_definitions: [{ slug: 'forecast', name: 'Forecast', description: 'd', inputs: JSON.stringify({ rows: { type: 'array', required: true, title: 'Rows' }, password: { type: 'string', default: 'hunter2' } }) }],
      recipe_definitions:   [{ slug: 'hello-recipe', name: 'Hello', description: 'd' }],
    });
    const items = await new PostgresUseCaseCatalogSource(db).listPublished();
    expect(items.find(row => row.slug === 'fetch-invoice')?.inputs).toEqual([{ name: 'invoice_id', label: 'Invoice ID', required: true }, { name: 'include_more' }]);
    expect(items.find(row => row.slug === 'forecast')?.inputs).toEqual([{ name: 'rows', label: 'Rows', required: true }]);
    expect(items.find(row => row.slug === 'hello-recipe')?.inputs).toBeUndefined();
    const serialized = JSON.stringify(items);
    for (const secret of ['sk_live_123', 'whsec_1', 'hunter2', 'Stripe invoice', '^in_']) expect(serialized).not.toContain(secret);
  });

  it('re-reads a single changed row under the same publication filter', async() => {
    // risk: data accuracy — an event for a draft or disabled row must resolve to "not published".
    const db = new FakeDb();
    expect(await new PostgresUseCaseCatalogSource(db, ['bundled']).findPublished('skill', 'draft-skill')).toBeNull();
    const call = db.calls[0];
    expect(call.sql).toContain('enabled=true AND deleted_at IS NULL');
    expect(call.sql).toContain('slug=$2');
    expect(call.params).toEqual([['bundled'], 'draft-skill']);
  });

  it('fingerprints the published set so event-less CRUD is detectable', async() => {
    // risk: data accuracy — reconciliation depends on the hash covering every type under the published filter.
    const db = new FakeDb();
    (db as any).query = async(sql: string, params?: unknown[]) => { db.calls.push({ sql, params }); return [{ fp: 'abc' }]; };
    expect(await new PostgresUseCaseCatalogSource(db, ['b']).fingerprint()).toBe('abc');
    const sql = db.calls[0].sql;
    for (const table of ['skill_definitions', 'agent_definitions', 'workflows', 'function_definitions', 'recipe_definitions']) expect(sql).toContain(`FROM ${ table }`);
    expect(sql).toContain("status='production'");
  });
});
