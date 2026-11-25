// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AgentJobRepository } from '../../../app/Repositories/AgentJobRepository';
import { ChatHeartbeatJobRepository, type ChatHeartbeatJobRecord } from '../../../app/Repositories/ChatHeartbeatJobRepository';
import type { AgentJob } from '../../../tools/agents/jobRegistry';
import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

// Real Postgres with the real migration registry (0171 included): the upsert, the CHECK
// constraints and the foreign key are part of the behavior, so no SQL fake stands in for them.
dbDescribe('ChatHeartbeatJobRepository (real Postgres)', () => {
  const database = new TestDatabase();
  let heartbeats: ChatHeartbeatJobRepository;
  let jobs: AgentJobRepository;

  beforeAll(async() => {
    await database.initialize();
    heartbeats = new ChatHeartbeatJobRepository({ query: (sql: string, values: unknown[] = []) => database.query(sql, values) } as any);
    jobs = new AgentJobRepository(new PostgresConnection({ query: async(sql, bindings) => {
      const rows = await database.query(sql, [...(bindings ?? [])]);
      return { rows, rowCount: rows.length };
    } }));
  }, 60_000);
  afterAll(async() => database.dispose());
  beforeEach(async() => { await database.query('TRUNCATE agent_jobs CASCADE') });

  const job = (jobId: string): AgentJob => ({
    jobId, status: 'running', createdAt: Date.now(), finishedAt: null, taskCount: 1, results: [],
    tasks: [{ agentId: 'worker', label: 'lane', prompt: 'work', status: 'running', threadId: `${ jobId }-thread` }],
    visibility: 'hidden', completionDeliveredAt: null, dismissedAt: null,
  });
  const record = (jobId: string, overrides: Partial<ChatHeartbeatJobRecord> = {}): ChatHeartbeatJobRecord => ({
    jobId, taskIndex: 0, threadId: `${ jobId }-thread`, channel: 'sulla-desktop',
    config: { intervalMinutes: 5, message: 'Keep working.', startedAt: 1_000, expiresAt: 21_601_000, setBy: 'agent' },
    startedAt: 1_000, expiresAt: 21_601_000, setBy: 'agent', ...overrides,
  });

  it('saves, restores and deletes a job heartbeat with its original deadline and setter', async() => {
    // risk: data accuracy — a restart loses the delegated heartbeat or re-stamps its six-hour deadline.
    await jobs.insertJob(job('heartbeat-round-trip'));
    const saved = record('heartbeat-round-trip');

    await heartbeats.save(saved);
    expect(await heartbeats.all()).toEqual([saved]);

    await heartbeats.delete(saved.jobId, saved.taskIndex);
    expect(await heartbeats.all()).toEqual([]);
  });

  it('keeps one row per job task: setting the heartbeat again replaces the interval, setter and window', async() => {
    // risk: duplicate rows make a restart register the same heartbeat twice, or restore the stale interval.
    await jobs.insertJob(job('heartbeat-upsert'));
    await heartbeats.save(record('heartbeat-upsert'));
    const replaced = record('heartbeat-upsert', {
      config: { intervalMinutes: 30, message: 'Report.', startedAt: 5_000, expiresAt: 21_605_000, setBy: 'human' },
      startedAt: 5_000, expiresAt: 21_605_000, setBy: 'human',
    });

    await heartbeats.save(replaced);

    expect(await heartbeats.all()).toEqual([replaced]);
    expect(await database.query('SELECT count(*)::int AS rows FROM agent_job_heartbeats')).toEqual([{ rows: 1 }]);
  });

  it('refuses a window that does not end after it starts, an unknown setter, and a job that does not exist', async() => {
    // risk: data accuracy — a corrupt record would restore a heartbeat that can never expire.
    await jobs.insertJob(job('heartbeat-constraints'));
    await expect(heartbeats.save(record('heartbeat-constraints', { startedAt: 9_000, expiresAt: 9_000 }))).rejects.toThrow();
    await expect(heartbeats.save(record('heartbeat-constraints', { setBy: 'stranger' as any }))).rejects.toThrow();
    await expect(heartbeats.save(record('heartbeat-no-such-job'))).rejects.toThrow();
    expect(await heartbeats.all()).toEqual([]);
  });

  it('removes the heartbeat with its job, and deleting one task leaves the other task untouched', async() => {
    // risk: a heartbeat row outlives its deleted job and wakes a thread that no longer exists.
    await jobs.insertJob(job('heartbeat-cascade'));
    await jobs.insertJob(job('heartbeat-survivor'));
    await heartbeats.save(record('heartbeat-cascade'));
    await heartbeats.save(record('heartbeat-survivor'));
    await heartbeats.save(record('heartbeat-survivor', { taskIndex: 1, threadId: 'heartbeat-survivor-thread-1' }));

    await database.query('DELETE FROM agent_jobs WHERE job_id = $1', ['heartbeat-cascade']);
    await heartbeats.delete('heartbeat-survivor', 0);

    expect((await heartbeats.all()).map(row => [row.jobId, row.taskIndex])).toEqual([['heartbeat-survivor', 1]]);
  });
});
