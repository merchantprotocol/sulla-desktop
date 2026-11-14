// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { mkdtemp, readdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditFileSink, type AuditFileEvent } from '../src/auditFileSink.js';
import { pruneLegacyOutboundAuditRows } from '../src/auditRetention.js';
import { AGENT_CREDENTIAL_USE_ACTION, HUMAN_REVEAL_ACTION, OutboundAuditRecorder } from '../src/outboundAudit.js';

let dir: string;
beforeEach(async() => { dir = await mkdtemp(join(tmpdir(), 'vault-audit-')); });
afterEach(async() => { await rm(dir, { recursive: true, force: true }); });

const event = (n = 0): Omit<AuditFileEvent, 'created_at'> => ({
  action: AGENT_CREDENTIAL_USE_ACTION, actor_user_id: 'u1', org_id: null, collection_id: null, item_id: `item-${ n }`,
  pod_id: 'pod', metadata: { agentId: 'a', operation: 'item.http' }, blocked: false, reason: null,
});

describe('AuditFileSink', () => {
  it('buffers writes without touching disk until flushed, then appends JSONL', async() => {
    const sink = new AuditFileSink({ dir, flushIntervalMs: 0, now: () => new Date('2026-01-02T03:04:05Z') });
    sink.write(event(1)); sink.write(event(2));
    expect(sink.buffered).toBe(2);
    expect(await readdir(dir)).toEqual([]);
    await sink.flush();
    const text = await readFile(join(dir, 'vault-audit-2026-01-02.jsonl'), 'utf8');
    const lines = text.trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.item_id)).toEqual(['item-1', 'item-2']);
    expect(lines[0].created_at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('never logs secret-looking metadata keys', async() => {
    const sink = new AuditFileSink({ dir, flushIntervalMs: 0 });
    sink.write({ ...event(), metadata: { agentId: 'a', password: 'hunter2', apiToken: 'x', secret_value: 'y', destination: 'h.example' } });
    await sink.flush();
    const text = (await Promise.all((await readdir(dir)).map(f => readFile(join(dir, f), 'utf8')))).join('');
    expect(text).not.toMatch(/hunter2|secret_value|apiToken|"password"/);
    expect(text).toContain('h.example');
  });

  it('drops and counts events beyond the buffer, and logs the drop', async() => {
    const logs: string[] = [];
    const sink = new AuditFileSink({ dir, flushIntervalMs: 0, maxBuffered: 3, log: m => logs.push(m) });
    for (let i = 0; i < 10; i++) sink.write(event(i));
    expect(sink.dropped).toBe(7);
    await sink.flush();
    expect(logs.join('\n')).toMatch(/dropped 7 event/);
    expect((await readFile(join(dir, (await readdir(dir))[0]), 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('counts and logs write failures instead of throwing', async() => {
    const logs: string[] = [];
    const blocker = join(dir, 'file');
    await writeFile(blocker, 'x');
    const sink = new AuditFileSink({ dir: join(blocker, 'sub'), flushIntervalMs: 0, log: m => logs.push(m) });
    sink.write(event());
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(sink.failedWrites).toBe(1);
    expect(logs.join('')).toMatch(/failed to write 1 event/);
  });

  it('rotates by size', async() => {
    const sink = new AuditFileSink({ dir, flushIntervalMs: 0, maxFileBytes: 600, now: () => new Date('2026-01-02T00:00:00Z') });
    for (let i = 0; i < 12; i++) { sink.write(event(i)); await sink.flush(); }
    const files = (await readdir(dir)).sort();
    expect(files.length).toBeGreaterThan(2);
    expect(files).toContain('vault-audit-2026-01-02.jsonl');
    for (const f of files) expect((await readFile(join(dir, f))).length).toBeLessThanOrEqual(700);
  });

  it('rotates by day and enforces age retention', async() => {
    let now = new Date('2026-01-01T12:00:00Z');
    const sink = new AuditFileSink({ dir, flushIntervalMs: 0, retentionDays: 14, now: () => now });
    sink.write(event(1)); await sink.flush();
    now = new Date('2026-01-10T12:00:00Z');
    sink.write(event(2)); await sink.flush();
    expect((await readdir(dir)).sort()).toEqual(['vault-audit-2026-01-01.jsonl', 'vault-audit-2026-01-10.jsonl']);
    now = new Date('2026-01-20T12:00:00Z');
    sink.write(event(3)); await sink.flush();
    expect((await readdir(dir)).sort()).toEqual(['vault-audit-2026-01-10.jsonl', 'vault-audit-2026-01-20.jsonl']);
  });

  it('enforces the total byte cap but never deletes the active file', async() => {
    let now = new Date('2026-02-01T00:00:00Z');
    const sink = new AuditFileSink({ dir, flushIntervalMs: 0, maxTotalBytes: 500, now: () => now });
    for (let d = 1; d <= 5; d++) {
      now = new Date(`2026-02-0${ d }T00:00:00Z`);
      for (let i = 0; i < 2; i++) sink.write(event(i));
      await sink.flush();
    }
    const files = (await readdir(dir)).sort();
    expect(files.at(-1)).toBe('vault-audit-2026-02-05.jsonl');
    expect(files.length).toBeLessThan(5);
  });

  it('reads recent events newest first with a filter and a limit, skipping torn lines', async() => {
    const sink = new AuditFileSink({ dir, flushIntervalMs: 0 });
    for (let i = 0; i < 5; i++) sink.write({ ...event(i), blocked: i % 2 === 1 });
    await sink.flush();
    await writeFile(join(dir, (await readdir(dir))[0]), '{"torn', { flag: 'a' });
    const blocked = await sink.readRecent(e => e.blocked, 10);
    expect(blocked.map(e => e.item_id)).toEqual(['item-3', 'item-1']);
    expect((await sink.readRecent(() => true, 2)).map(e => e.item_id)).toEqual(['item-4', 'item-3']);
  });
});

describe('reveal vs outbound use', () => {
  it('records agent credential use under its own action, never as a human reveal', async() => {
    const sink = new AuditFileSink({ dir, flushIntervalMs: 0 });
    const recorder = new OutboundAuditRecorder(sink);
    recorder.record({ actorUserId: 'u1', itemId: 'i1', agentId: 'agent-1', operation: 'item.http', destination: 'api.example.com', blocked: false });
    recorder.record({ actorUserId: 'u1', agentId: 'agent-1', operation: 'item.http', blocked: true, reason: 'policy_denied' });
    const events = await sink.readRecent(() => true, 10);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.action).toBe('agent_credential_use');
      expect(e.action).not.toBe(HUMAN_REVEAL_ACTION);
      expect(e.metadata.agentId).toBe('agent-1');
    }
    expect(events.map(e => e.blocked).sort()).toEqual([false, true]);
    expect(AGENT_CREDENTIAL_USE_ACTION).not.toContain('reveal');
  });
});

describe('pruneLegacyOutboundAuditRows', () => {
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
});
