// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { PostgresConnection } from '@sulla/foundation/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StrandedEpisodeRepository } from '../../app/Repositories/StrandedEpisodeRepository';
import type { StrandedAlertDispatcher } from '../../app/Services/StrandedManagerAlertService';
import { StrandedManagerDetector, type ManagerActivitySource, type StrandedManagerCandidate } from '../../app/Services/StrandedManagerDetector';
import { StrandedManagerScheduler } from '../../app/Services/StrandedManagerScheduler';
import type { FleetJobView, FleetTaskView } from '../../app/Services/AgentFleetTypes';
import { AgentCompletionInbox } from '../../services/AgentCompletionInbox';
import { StrandedManagerAlertService } from '../../app/Services/StrandedManagerAlertService';
import { TestDatabase } from '../Support/TestDatabase';
import { AgentJobRepository } from '../../app/Repositories/AgentJobRepository';
import { AgentStateService } from '../../app/Services/AgentStateService';
import { JobRuntimeRegistry } from '../../app/Services/JobRuntimeRegistry';
import { AgentFleetProjectionService } from '../../app/Services/AgentFleetProjectionService';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;
const now = Date.parse('2026-11-05T12:00:00.000Z');
const iso = (ago: number) => new Date(now - ago).toISOString();

class FakeFleet {
  constructor(public jobs: FleetJobView[]) {}
  async supervisionCandidates(): Promise<FleetJobView[]> { return this.jobs }
}
class FailingOnceDispatcher implements StrandedAlertDispatcher {
  calls = 0;
  async alert(): Promise<boolean> { this.calls++; if (this.calls === 1) throw new Error('dispatcher unavailable'); return true }
}
class DeferredDispatcher implements StrandedAlertDispatcher {
  active = 0; maxActive = 0;
  readonly entered: Promise<void>;
  private release?: () => void; private markEntered!: () => void;
  constructor() { this.entered = new Promise(resolve => { this.markEntered = resolve }) }
  async alert(): Promise<boolean> { this.active++; this.markEntered(); this.maxActive = Math.max(this.maxActive, this.active); await new Promise<void>(resolve => { this.release = resolve }); this.active--; return true }
  resolve(): void { this.release?.() }
}

const task = (overrides: Partial<FleetTaskView> = {}): FleetTaskView => ({ taskIndex: 0, agentId: 'manager', label: 'Manager', status: 'parked',
  returned: false, startedAt: iso(60 * 60_000), finishedAt: null, returnedAt: null, completionDeliveredAt: null,
  lastActivityAt: iso(60 * 60_000), threadId: 'manager-thread', parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', latestCheckin: null, ...overrides });
const manager = (id: string, overrides: Partial<FleetTaskView> = {}): FleetJobView => ({ jobId: id, status: 'parked', createdAt: iso(60 * 60_000), finishedAt: null,
  parentThreadId: 'grandparent-thread', parentChannel: 'sulla-desktop', parentJobId: null, parentTaskIndex: null, rootThreadId: 'root', tasks: [task(overrides)] });
const child = (managerId: string, suffix = '', overrides: Partial<FleetTaskView> = {}): FleetJobView => ({ jobId: `child-${ managerId }-${ suffix }`, status: 'completed', createdAt: iso(30 * 60_000), finishedAt: iso(20 * 60_000),
  parentThreadId: 'manager-thread', parentChannel: 'sulla-desktop', parentJobId: managerId, parentTaskIndex: 0, rootThreadId: 'root', tasks: [task({ agentId: 'worker', label: 'Worker', status: 'completed', returned: true,
    startedAt: iso(30 * 60_000), finishedAt: iso(20 * 60_000), returnedAt: iso(20 * 60_000), lastActivityAt: iso(20 * 60_000), threadId: `worker-${ suffix }`, parentJobId: managerId, parentTaskIndex: 0, ...overrides })] });

// risk: durable delivery, duplicate alerts, false stranded alerts, and overlapping schedulers.
dbDescribe('StrandedManagerScheduler durable delivery', () => {
  const database = new TestDatabase(); let episodes: StrandedEpisodeRepository;
  beforeAll(async() => {
    await database.initialize();
    const client = { query: async(sql: string, bindings?: readonly unknown[]) => { const rows = await database.query(sql, [...(bindings ?? [])]); return { rows, rowCount: rows.length } } } as unknown as ConstructorParameters<typeof PostgresConnection>[0];
    episodes = new StrandedEpisodeRepository(new PostgresConnection(client));
  }, 60_000);
  afterAll(async() => database.dispose());
  const persistManager = async(id: string): Promise<void> => {
    await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, parent_channel, parent_thread_id, created_at, tasks, visibility)
      VALUES ($1, 'parked', 1, 'sulla-desktop', 'grandparent-thread', now() - interval '1 hour', $2::jsonb, 'hidden') ON CONFLICT DO NOTHING`,
    [id, JSON.stringify([{ agentId: 'manager', label: 'Manager', prompt: 'work', status: 'parked', threadId: 'manager-thread', startedAt: now - 60 * 60_000 }])]);
  };

  it('lets two schedulers enqueue one notice and persists delivery outside agent_jobs JSON', async() => {
    const id = `concurrent-${ Date.now() }`; await persistManager(id); const fleet = new FakeFleet([manager(id), child(id)]); const inbox = new AgentCompletionInbox();
    const schedulerA = new StrandedManagerScheduler(fleet as never, new StrandedManagerDetector(() => now), episodes, new StrandedManagerAlertService(inbox));
    const schedulerB = new StrandedManagerScheduler(fleet as never, new StrandedManagerDetector(() => now), episodes, new StrandedManagerAlertService(inbox));
    expect((await Promise.all([schedulerA.tick(), schedulerB.tick()])).reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(inbox.take('sulla-desktop', 'grandparent-thread')).toHaveLength(1);
    const [row] = await database.query<{ status: string }>('SELECT status FROM agent_stranded_episodes WHERE manager_job_id = $1', [id]);
    expect(row.status).toBe('delivered');
  });

  it('retries after dispatcher failure and after restart between persistence and enqueue', async() => {
    const id = `retry-${ Date.now() }`; await persistManager(id); const fleet = new FakeFleet([manager(id), child(id)]); const failing = new FailingOnceDispatcher();
    const first = new StrandedManagerScheduler(fleet as never, new StrandedManagerDetector(() => now), episodes, failing);
    expect(await first.tick()).toBe(0); expect(await first.tick()).toBe(1); expect(failing.calls).toBe(2);
    const restartId = `${ id }-restart`; await persistManager(restartId); const [candidate] = new StrandedManagerDetector(() => now).detect([manager(restartId), child(restartId)]);
    await episodes.insertPending(candidate);
    const inbox = new AgentCompletionInbox();
    const restarted = new StrandedManagerScheduler(new FakeFleet([]) as never, new StrandedManagerDetector(() => now), episodes, new StrandedManagerAlertService(inbox));
    expect(await restarted.tick()).toBe(1); expect(inbox.take('sulla-desktop', 'grandparent-thread')).toHaveLength(1);
  });

  it('serializes deferred ticks, honours future waits and live activity, and alerts a changed episode once', async() => {
    const deferredId = `deferred-${ Date.now() }`; await persistManager(deferredId); const dispatcher = new DeferredDispatcher();
    const scheduler = new StrandedManagerScheduler(new FakeFleet([manager(deferredId), child(deferredId)]) as never, new StrandedManagerDetector(() => now), episodes, dispatcher);
    const first = scheduler.tick(); const second = scheduler.tick(); await dispatcher.entered; dispatcher.resolve();
    expect(await first).toBe(1); expect(await second).toBe(1); expect(dispatcher.maxActive).toBe(1);
    const waitingId = `${ deferredId }-waiting`; const active: ManagerActivitySource = { isActive: () => true };
    expect(new StrandedManagerDetector(() => now).detect([manager(waitingId, { wakeAt: iso(-60_000) }), child(waitingId)])).toEqual([]);
    expect(new StrandedManagerDetector(() => now, active).detect([manager(waitingId), child(waitingId)])).toEqual([]);
    const changedId = `${ deferredId }-changed`; await persistManager(changedId); const fleet = new FakeFleet([manager(changedId), child(changedId)]); const inbox = new AgentCompletionInbox();
    const changed = new StrandedManagerScheduler(fleet as never, new StrandedManagerDetector(() => now), episodes, new StrandedManagerAlertService(inbox));
    expect(await changed.tick()).toBe(1); fleet.jobs = [manager(changedId), child(changedId, 'new', { returnedAt: iso(11 * 60_000), finishedAt: iso(11 * 60_000) })];
    expect(await changed.tick()).toBe(1); expect(await changed.tick()).toBe(0);
  });

  it('detects all 20 managers across more than 100 terminal children', () => {
    const jobs: FleetJobView[] = [];
    for (let index = 0; index < 20; index++) { const id = `scale-${ index }`; jobs.push(manager(id)); for (let childIndex = 0; childIndex < 6; childIndex++) jobs.push(child(id, String(childIndex))); }
    expect(new StrandedManagerDetector(() => now).detect(jobs)).toHaveLength(20);
  });

  it('projects all 20 managers and 120 terminal descendants through real Postgres state without the list limit', async() => {
    // risk: data accuracy -- newest-100 truncation hides terminal descendants and suppresses stranded-manager reconciliation
    const prefix = `scale-real-${ Date.now() }`;
    for (let managerIndex = 0; managerIndex < 20; managerIndex++) {
      const managerId = `${ prefix }-manager-${ managerIndex }`;
      const managerThread = `${ managerId }-thread`;
      await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, parent_channel, parent_thread_id, created_at, tasks, visibility)
        VALUES ($1, 'parked', 1, 'sulla-desktop', $2, now() - interval '1 hour', $3::jsonb, 'hidden')`, [managerId, `${ prefix }-root`, JSON.stringify([
        { agentId: 'manager', label: 'Manager', prompt: 'manage', status: 'parked', threadId: managerThread, startedAt: now - 60 * 60_000 },
      ])]);
      for (let childIndex = 0; childIndex < 6; childIndex++) {
        const childId = `${ managerId }-child-${ childIndex }`;
        await database.query(`INSERT INTO agent_jobs (job_id, status, task_count, parent_channel, parent_thread_id, created_at, finished_at, tasks, visibility)
          VALUES ($1, 'completed', 1, 'sulla-desktop', $2, now() - interval '30 minutes', now() - interval '20 minutes', $3::jsonb, 'hidden')`,
        [childId, managerThread, JSON.stringify([{ agentId: 'worker', label: 'Worker', prompt: 'work', status: 'completed', threadId: `${ childId }-thread`,
          startedAt: now - 30 * 60_000, finishedAt: now - 20 * 60_000, returnedAt: now - 20 * 60_000,
          completion: { label: 'Worker', status: 'completed', output: 'done', threadId: `${ childId }-thread` } }])]);
      }
    }

    const client = { query: async(sql: string, bindings?: readonly unknown[]) => { const rows = await database.query(sql, [...(bindings ?? [])]); return { rows, rowCount: rows.length } } } as unknown as ConstructorParameters<typeof PostgresConnection>[0];
    const connection = new PostgresConnection(client);
    const states = new AgentStateService(new AgentJobRepository(connection as never), new JobRuntimeRegistry(), () => now);
    const telemetry = { telemetryForJob: async() => ({}), latestTelemetryForJobs: async() => ({}) };
    const titles = { titlesForThreadIds: async() => ({}) };
    const fleet = new AgentFleetProjectionService(states, telemetry, titles as never, () => now);
    const projected = (await fleet.supervisionCandidates()).filter(job => job.jobId.startsWith(prefix));

    expect(projected).toHaveLength(140);
    expect(new StrandedManagerDetector(() => now).detect(projected)).toHaveLength(20);
  });
});
