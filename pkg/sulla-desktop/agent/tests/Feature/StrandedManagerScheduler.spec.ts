// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StrandedEpisodeRepository } from '../../app/Repositories/StrandedEpisodeRepository';
import { StrandedManagerAlertService } from '../../app/Services/StrandedManagerAlertService';
import { StrandedManagerDetector } from '../../app/Services/StrandedManagerDetector';
import { StrandedManagerScheduler } from '../../app/Services/StrandedManagerScheduler';
import type { FleetJobView } from '../../app/Services/AgentFleetTypes';
import { AgentCompletionInbox } from '../../services/AgentCompletionInbox';
import { TestDatabase } from '../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;
const now = Date.parse('2026-11-05T12:00:00.000Z');
const iso = (ago: number) => new Date(now - ago).toISOString();

dbDescribe('StrandedManagerScheduler with real Postgres', () => {
  const database = new TestDatabase();
  let episodes: StrandedEpisodeRepository;
  beforeAll(async() => {
    await database.initialize();
    const testClient = { query: async(sql: string, bindings?: readonly unknown[]) => {
      const rows = await database.query(sql, [...(bindings ?? [])]);
      return { rows, rowCount: rows.length };
    } } as unknown as ConstructorParameters<typeof PostgresConnection>[0];
    const connection = new PostgresConnection(testClient);
    episodes = new StrandedEpisodeRepository(connection);
  }, 60_000);
  afterAll(async() => database.dispose());

  it('persists an episode before alerting the correct parent exactly once, then permits a changed episode', async() => {
    // risk: retries duplicate escalation, or a failed child wake alerts the manager instead of its parent.
    const jobId = `stranded-manager-${ Date.now() }`;
    await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, parent_channel, parent_thread_id, created_at, tasks, visibility)
      VALUES ($1, 'parked', 1, 'sulla-desktop', 'grandparent-thread', now() - interval '1 hour', $2::jsonb, 'hidden')`,
    [jobId, JSON.stringify([{ agentId: 'manager', label: 'Manager', prompt: 'work', status: 'parked', threadId: 'manager-thread', startedAt: now - 60 * 60_000 }])]);
    const manager: FleetJobView = { jobId, status: 'parked', createdAt: iso(60 * 60_000), finishedAt: null,
      parentThreadId: 'grandparent-thread', parentChannel: 'sulla-desktop', parentJobId: null, parentTaskIndex: null, rootThreadId: 'root',
      tasks: [{ taskIndex: 0, agentId: 'manager', label: 'Manager', status: 'parked', returned: false, startedAt: iso(60 * 60_000), finishedAt: null,
        returnedAt: null, completionDeliveredAt: null, lastActivityAt: iso(20 * 60_000), threadId: 'manager-thread', parentJobId: null,
        parentTaskIndex: null, rootThreadId: 'root', latestCheckin: null }] };
    const child = (terminalAgo: number, delivered = false): FleetJobView => ({ jobId: 'child-job', status: 'completed', createdAt: iso(30 * 60_000),
      finishedAt: iso(terminalAgo), parentThreadId: 'manager-thread', parentJobId: jobId, parentTaskIndex: 0, rootThreadId: 'root', tasks: [{
        taskIndex: 0, agentId: 'worker', label: 'Worker', status: 'completed', returned: true, startedAt: iso(30 * 60_000), finishedAt: iso(terminalAgo),
        returnedAt: iso(terminalAgo), completionDeliveredAt: delivered ? iso(terminalAgo - 1_000) : null, lastActivityAt: iso(terminalAgo), threadId: 'worker-thread',
        parentJobId: jobId, parentTaskIndex: 0, rootThreadId: 'root', latestCheckin: null }] });
    let jobs = [manager, child(10 * 60_000)];
    const fleet = { list: async() => jobs };
    const inbox = new AgentCompletionInbox();
    const scheduler = new StrandedManagerScheduler(fleet as never, new StrandedManagerDetector(() => now), episodes, new StrandedManagerAlertService(inbox));

    expect(await scheduler.tick()).toBe(1);
    expect(await scheduler.tick()).toBe(0);
    const first = inbox.take('sulla-desktop', 'grandparent-thread');
    expect(first).toHaveLength(1);
    expect(first[0].notice).toContain(`stranded manager Manager (job ${ jobId } task 0)`);
    expect(inbox.take('sulla-desktop', 'manager-thread')).toEqual([]);
    const [persisted] = await database.query<{ state_key: string }>(`SELECT tasks->0->'stranded'->>'stateKey' AS state_key FROM agent_jobs WHERE job_id = $1`, [jobId]);
    expect(persisted.state_key).toBe(first[0].dedupeKey);

    jobs = [manager, child(10 * 60_000, true)];
    expect(await scheduler.tick()).toBe(0);
    jobs = [manager, child(11 * 60_000)];
    expect(await scheduler.tick()).toBe(1);
    expect(await scheduler.tick()).toBe(0);
    expect(inbox.take('sulla-desktop', 'grandparent-thread')).toHaveLength(1);
  });
});
