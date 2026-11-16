// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { LegacyOutboundAuditPruner, type PruneOptions } from '../src/auditRetention.js';
import { PostgresLegacyAuditRepository } from '../src/repositories/PostgresLegacyAuditRepository.js';

const pruneLegacyOutboundAuditRows = (db: any, options?: PruneOptions) => new LegacyOutboundAuditPruner(new PostgresLegacyAuditRepository(db), options).prune();

describe('LegacyOutboundAuditPruner', () => {
  function fakeDb(total: number, marked = false) {
    const state = { remaining: total, marked, batches: 0, sizes: [] as number[], cursors: [] as number[], inserts: 0 };
    return { state, db: { query: async(sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT 1 FROM vault_schema_migrations')) return { rows: state.marked ? [{}] : [] };
      if (sql.includes('INSERT INTO vault_schema_migrations')) { state.marked = true; state.inserts++; return { rows: [] }; }
      const size = params[2] as number;
      const n = Math.min(size, state.remaining);
      state.remaining -= n; state.batches++; state.sizes.push(size); state.cursors.push(params[1] as number);
      return { rows: [{ n, last: n ? state.cursors.length * 1000 : params[1] }] };
    } } as any };
  }

  it('deletes in bounded batches until none remain, then marks itself done and logs the VACUUM note', async() => {
    const { db, state } = fakeDb(12_500);
    const logs: string[] = [];
    const deleted = await pruneLegacyOutboundAuditRows(db, { batchSize: 5000, pauseMs: 0, sleep: async() => undefined, log: m => logs.push(m) });
    expect(deleted).toBe(12_500);
    expect(state.sizes.every(s => s === 5000)).toBe(true);
    expect(state.cursors).toEqual([0, 1000, 2000, 3000]); // keyset cursor advances; never rescans from the start
    expect(state.inserts).toBe(1);
    expect(logs.join('\n')).toMatch(/VACUUM/);
  });

  it('is idempotent: a marked database is not touched', async() => {
    const { db, state } = fakeDb(10, true);
    expect(await pruneLegacyOutboundAuditRows(db)).toBe(0);
    expect(state.batches).toBe(0);
  });

  it('can pause after maxBatches without marking done, and resumes later', async() => {
    const { db, state } = fakeDb(30_000);
    const opts = { batchSize: 5000, pauseMs: 0, sleep: async() => undefined, log: () => undefined };
    expect(await pruneLegacyOutboundAuditRows(db, { ...opts, maxBatches: 2 })).toBe(10_000);
    expect(state.marked).toBe(false);
    expect(await pruneLegacyOutboundAuditRows(db, opts)).toBe(20_000);
    expect(state.marked).toBe(true);
  });

  it('only ever deletes the legacy outbound action and clamps the batch size', async() => {
    // risk: data loss — the sweep must never delete other audit actions or run unbounded batches.
    const deletes: unknown[][] = [];
    const db = { query: async(sql: string, params: unknown[] = []) => {
      if (sql.includes('DELETE FROM audit_log')) { deletes.push(params); return { rows: [{ n: 0, last: params[1] }] }; }
      return { rows: [] };
    } } as any;
    await pruneLegacyOutboundAuditRows(db, { batchSize: 1_000_000, pauseMs: 0, log: () => undefined });
    expect(deletes).toEqual([['vault_outbound_request', 0, 20_000]]);
  });
});
