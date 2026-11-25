// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/main/SleepPreventionService', () => ({ acquireChatActivity: vi.fn(), releaseChatActivity: vi.fn() }));
vi.mock('@pkg/agent/services/GraphRegistry', () => ({ GraphRegistry: { get: vi.fn() } }));
const network = vi.hoisted(() => ({ wake: vi.fn(async() => true), send: vi.fn(async() => true) }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: network.send }) }));
vi.mock('@pkg/agent/services/AgentWaitServices', () => ({ agentWaitProvider: { repository: { pending: async() => null } } }));
vi.mock('@pkg/agent/services/BackendGraphWebSocketService', () => ({
  getBackendGraphWebSocketService: () => ({ wakeParkedAgent: network.wake }),
}));

import { ChatHeartbeatServiceProvider } from '@pkg/agent/app/Providers/ChatHeartbeatServiceProvider';
import { AgentStateService, type AgentStateStore } from '@pkg/agent/app/Services/AgentStateService';
import type { AgentJob, AgentJobTask } from '@pkg/agent/tools/agents/jobRegistry';
import { MemoryHeartbeatStore } from '../../Support/MemoryHeartbeatStore';

const MINUTE = 60_000;
const SIX_HOURS_MS = 6 * 60 * MINUTE;
const START = Date.UTC(2026, 10, 24, 20, 0, 0);

/** The durable agent_jobs table, in memory, behind the real AgentStateService. */
class MemoryJobStore implements AgentStateStore {
  readonly durable = new Map<string, AgentJob>();
  constructor(jobs: AgentJob[]) { for (const job of jobs) this.durable.set(job.jobId, structuredClone(job)) }
  async allJobs(): Promise<AgentJob[]> { return [...this.durable.values()].map(job => structuredClone(job)) }
  async job(jobId: string): Promise<AgentJob | undefined> {
    const job = this.durable.get(jobId);
    return job ? structuredClone(job) : undefined;
  }
  async jobsForList(_limit: number, includeFinished: boolean): Promise<AgentJob[]> {
    return (await this.allJobs()).filter(job => includeFinished || ['running', 'parked'].includes(job.status));
  }
  async insertJob(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)) }
  async replaceState(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)) }
  async cascadeJobs(jobId: string): Promise<AgentJob[]> {
    const job = this.durable.get(jobId);
    return job ? [structuredClone(job)] : [];
  }
  async replaceStateIfActivityUnchanged(job: AgentJob): Promise<boolean> { this.durable.set(job.jobId, structuredClone(job)); return true }
}

const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask =>
  ({ agentId: 'codex-sol-worker', label: 'Worker', prompt: 'work', status: 'parked', startedAt: START, ...overrides });
const job = (jobId: string, tasks: AgentJobTask[], overrides: Partial<AgentJob> = {}): AgentJob => ({
  jobId, status: 'parked', createdAt: START, finishedAt: null, taskCount: tasks.length, results: [], tasks,
  visibility: 'hidden', parentChannel: 'sulla-desktop', ...overrides,
});

/** The real provider, scheduler, delivery and registration services over the real job-state service. */
function harness(jobs: AgentJob[], heartbeats = new MemoryHeartbeatStore()) {
  const store = new MemoryJobStore(jobs);
  const states = new AgentStateService(store, { jobs: new Map() }, () => Date.now());
  const provider = new ChatHeartbeatServiceProvider({
    jobChanges: states,
    jobHeartbeats: heartbeats,
    getJob: jobId => store.job(jobId),
    hasRunningChildren: async() => false,
    taskForThread: async(threadId) => {
      for (const candidate of await store.allJobs()) {
        const taskIndex = candidate.tasks.findIndex(entry => entry.threadId === threadId);
        if (taskIndex >= 0) return { jobId: candidate.jobId, taskIndex, jobStatus: candidate.status, taskStatus: candidate.tasks[taskIndex].status };
      }
      return null;
    },
    queueJobMessage: async() => ({ id: 'queued' }),
    now: () => Date.now(),
  });
  return { store, states, provider, heartbeats };
}

describe('delegated job heartbeat lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); network.wake.mockClear(); network.send.mockClear() });
  afterEach(() => { vi.useRealTimers() });

  it('treats a heartbeat set from the composer on a delegated-job thread as a job heartbeat', async() => {
    // risk: a composer-set heartbeat on a job thread is sent as a plain user turn into a running worker,
    // ignores the job minimum interval and is lost on restart because nothing was saved.
    const { provider, heartbeats } = harness([job('tab-job', [task({ threadId: 'other' }), task({ threadId: 'tab-thread' })], { visibility: 'tab' })]);
    const registrations = provider.registrations();

    // The tab mounts and registers with only a thread id, then the human switches a 1-minute heartbeat on.
    await registrations.register({ threadId: 'tab-thread', channel: 'sulla-desktop', config: { intervalMinutes: null, message: 'Check in.' } });
    const status = await registrations.configure('tab-thread', { intervalMinutes: 1, message: 'Check in.', setBy: 'human' });

    expect(status).toMatchObject({ enabled: true, intervalMinutes: 5, setBy: 'human', expiresAt: START + SIX_HOURS_MS });
    expect(provider.scheduler().jobTarget('tab-thread')).toEqual({ jobId: 'tab-job', taskIndex: 1 });
    expect(heartbeats.records).toEqual([expect.objectContaining({
      jobId: 'tab-job', taskIndex: 1, threadId: 'tab-thread', setBy: 'human', expiresAt: START + SIX_HOURS_MS,
      config: expect.objectContaining({ intervalMinutes: 5 }),
    })]);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    // Delivered through the parked-job wake, never as a user_message turn on the tab's channel.
    expect(network.wake).toHaveBeenCalledTimes(1);
    expect(network.wake.mock.calls[0]?.[1]).toBe('tab-thread');
    expect(network.send).not.toHaveBeenCalled();

    // Switching it off from the composer removes the durable record too.
    await registrations.configure('tab-thread', { intervalMinutes: null, message: 'Check in.', setBy: 'human' });
    expect(heartbeats.records).toEqual([]);
    provider.scheduler().unregister('tab-thread');
  });

  it('re-binds and saves a job heartbeat when a tab re-registers after a restart with no record behind it', async() => {
    // risk: after a restart the tab's saved heartbeat comes back as a chat heartbeat with a fresh six hours.
    const { provider, heartbeats } = harness([job('restarted-job', [task({ threadId: 'restarted-thread' })], { visibility: 'tab' })]);
    const startedAt = START - 2 * 60 * MINUTE;
    const expiresAt = startedAt + SIX_HOURS_MS;

    const status = await provider.registrations().register({
      threadId: 'restarted-thread', channel: 'sulla-desktop',
      config: { intervalMinutes: 2, message: 'Keep going.', startedAt, expiresAt, setBy: 'human' },
    });

    expect(status).toMatchObject({ enabled: true, intervalMinutes: 5, startedAt, expiresAt });
    expect(provider.scheduler().jobTarget('restarted-thread')).toEqual({ jobId: 'restarted-job', taskIndex: 0 });
    expect(heartbeats.records).toEqual([expect.objectContaining({ jobId: 'restarted-job', taskIndex: 0, startedAt, expiresAt })]);
    provider.scheduler().unregister('restarted-thread');
  });

  it('does not let a tab that re-registers a stale "off" delete the job record recovery has yet to restore', async() => {
    // risk: data loss — the startup race between a tab and recovery destroys a live job heartbeat.
    const record = {
      jobId: 'raced-job', taskIndex: 0, threadId: 'raced-thread', channel: 'sulla-desktop',
      config: { intervalMinutes: 10, message: 'Keep going.', startedAt: START - MINUTE, expiresAt: START - MINUTE + SIX_HOURS_MS, setBy: 'agent' as const },
      startedAt: START - MINUTE, expiresAt: START - MINUTE + SIX_HOURS_MS, setBy: 'agent' as const,
    };
    const { provider, heartbeats } = harness([job('raced-job', [task({ threadId: 'raced-thread' })], { visibility: 'tab' })], new MemoryHeartbeatStore([record]));

    await provider.registrations().register({ threadId: 'raced-thread', channel: 'sulla-desktop', config: { intervalMinutes: null, message: 'Keep going.' } });
    expect(heartbeats.records).toEqual([record]);

    await provider.rehydrateJobHeartbeats();
    expect(provider.scheduler().status('raced-thread')).toMatchObject({ enabled: true, intervalMinutes: 10, expiresAt: record.expiresAt });
    provider.scheduler().unregister('raced-thread');
  });

  it('leaves an ordinary chat thread, or a thread whose job already finished, as a chat heartbeat', async() => {
    // risk: tenant-style mix-up — a chat heartbeat is bound to a finished job and silently never fires.
    const { provider, heartbeats } = harness([job('done-job', [task({ threadId: 'done-thread', status: 'completed' })], { status: 'completed' })]);
    const registrations = provider.registrations();
    for (const threadId of ['plain-chat', 'done-thread']) {
      await registrations.register({ threadId, channel: 'sulla-desktop', config: { intervalMinutes: null, message: 'Check.' } });
      const status = await registrations.configure(threadId, { intervalMinutes: 1, message: 'Check.', setBy: 'human' });
      expect(status).toMatchObject({ enabled: true, intervalMinutes: 1 });
      expect(provider.scheduler().jobTarget(threadId)).toBeUndefined();
    }
    expect(heartbeats.records).toEqual([]);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(network.send).toHaveBeenCalledTimes(2);
    expect(network.wake).not.toHaveBeenCalled();
    provider.scheduler().unregister('plain-chat');
    provider.scheduler().unregister('done-thread');
  });

  it('clears the heartbeat and its record when the job is stopped through the real stop cascade', async() => {
    // risk: stop_agent_job leaves a timer that keeps waking an agent the manager stopped.
    const { provider, states, heartbeats } = harness([job('stopped-job', [task({ threadId: 'stopped-thread' })])]);
    await provider.ensureJobLifecycleSubscription();
    const scheduler = provider.scheduler();
    scheduler.register({
      threadId: 'stopped-thread', channel: 'sulla-desktop', jobId: 'stopped-job', taskIndex: 0,
      config: { intervalMinutes: null, message: 'Keep going.', setBy: 'agent' },
    });
    scheduler.configure('stopped-thread', { intervalMinutes: 5, message: 'Keep going.', setBy: 'agent' });
    await vi.advanceTimersByTimeAsync(0);
    expect(heartbeats.records.map(row => row.jobId)).toEqual(['stopped-job']);

    expect(await states.stopCascade('stopped-job', 'human', 'Stopped by manager')).toEqual(['stopped-job']);
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

    expect(scheduler.has('stopped-thread')).toBe(false);
    expect(heartbeats.records).toEqual([]);
    expect(network.wake).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the heartbeat of a job that a restart resumes, with its original deadline', async() => {
    // risk: the restart-resume claim is mistaken for the task settling and wipes the heartbeat it should keep.
    const startedAt = START - 60 * MINUTE;
    const expiresAt = startedAt + SIX_HOURS_MS;
    const record = {
      jobId: 'resumed-job', taskIndex: 0, threadId: 'resumed-thread', channel: 'sulla-desktop',
      config: { intervalMinutes: 15, message: 'Keep going.', startedAt, expiresAt, setBy: 'agent' as const },
      startedAt, expiresAt, setBy: 'agent' as const,
    };
    const { provider, states, heartbeats } = harness(
      [job('resumed-job', [task({ threadId: 'resumed-thread', status: 'running' })], { status: 'running' })],
      new MemoryHeartbeatStore([record]),
    );

    await provider.rehydrateJobHeartbeats();
    const claimed = await states.claimInterruptedJobs();
    await vi.advanceTimersByTimeAsync(0);

    expect(claimed.resumable.map(entry => entry.jobId)).toEqual(['resumed-job']);
    expect(provider.scheduler().status('resumed-thread')).toMatchObject({ enabled: true, intervalMinutes: 15, startedAt, expiresAt });
    expect(provider.scheduler().jobTarget('resumed-thread')).toEqual({ jobId: 'resumed-job', taskIndex: 0 });
    expect(heartbeats.records).toEqual([record]);
    provider.scheduler().unregister('resumed-thread');
  });
});
