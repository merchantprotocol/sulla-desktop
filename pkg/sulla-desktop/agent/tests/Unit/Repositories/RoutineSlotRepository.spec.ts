// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { ArtifactCustodyRepository } from '../../../app/Repositories/ArtifactCustodyRepository';
import { RoutineSlotRepository } from '../../../app/Repositories/RoutineSlotRepository';

/** Fake Postgres client whose transaction runs against a fake PoolClient holding `held` slots. */
class FakeSlotClient {
  readonly txCalls: { sql: string; params?: unknown[] }[] = [];
  readonly calls: { sql: string; params?: unknown[] }[] = [];
  constructor(private readonly held: number, private readonly rows: unknown[] = []) {}
  query = vi.fn(async(sql: string, params?: unknown[]) => { this.calls.push({ sql, params }); return this.rows as any[] });
  queryOne = vi.fn(async(sql: string, params?: unknown[]) => { this.calls.push({ sql, params }); return { count: String(this.held) } as any });
  transaction = vi.fn(async(callback: (client: any) => Promise<any>) => callback({
    query: async(sql: string, params?: unknown[]) => {
      this.txCalls.push({ sql, params });
      return { rows: sql.includes('COUNT(*)') ? [{ count: String(this.held) }] : [] };
    },
  }));
}

const reservation = { id: 'slot-1', kind: 'execution', owner: 'w', taskId: 't' };

describe('RoutineSlotRepository', () => {
  // risk: capacity — a slot is reserved under the advisory lock only while fewer than `limit` slots are held.
  it('reserves under the lock when capacity remains', async() => {
    const client = new FakeSlotClient(1);
    await expect(new RoutineSlotRepository(client).reserveUnderLimit(2, reservation)).resolves.toBe('slot-1');
    expect(client.txCalls[0]).toEqual({ sql: 'SELECT pg_advisory_xact_lock($1)', params: [4823710298] });
    expect(client.txCalls[2].params).toEqual(['slot-1', 'execution', 'w', 't']);
  });

  it('refuses without inserting when the limit is reached', async() => {
    const client = new FakeSlotClient(2);
    await expect(new RoutineSlotRepository(client).reserveUnderLimit(2, reservation)).resolves.toBeNull();
    expect(client.txCalls.some(call => call.sql.startsWith('INSERT'))).toBe(false);
  });

  it('counts active slots, optionally by kind', async() => {
    const client = new FakeSlotClient(3);
    await expect(new RoutineSlotRepository(client).countActive(null)).resolves.toBe(3);
    expect(client.calls[0].params).toEqual([null]);
  });

  it('reports how many stale slots were reclaimed', async() => {
    const client = new FakeSlotClient(0, [{ id: 'a' }, { id: 'b' }]);
    await expect(new RoutineSlotRepository(client).deleteStale(45)).resolves.toBe(2);
    expect(client.calls[0].params).toEqual([45]);
  });
});

describe('ArtifactCustodyRepository', () => {
  // risk: data accuracy — custody audit rows store the custody JSON and actor inside the caller's transaction.
  it('inserts the custody row through the caller transaction client', async() => {
    const query = vi.fn(async() => ({ rows: [] }));
    await new ArtifactCustodyRepository().insertWithClient({ query } as any, {
      id: 'custody-1', taskId: 'task-1', transition: 'done', workKind: 'code', custody: { branch: 'b' }, actor: 'agent',
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO work_task_artifact_custody'),
      ['custody-1', 'task-1', 'done', 'code', JSON.stringify({ branch: 'b' }), 'agent']);
  });
});
