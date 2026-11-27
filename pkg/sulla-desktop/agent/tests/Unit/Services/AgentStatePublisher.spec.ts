// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '../../../tools/agents/jobRegistry';
import { AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import { AgentStateProjector } from '../../../app/Services/AgentStateProjector';
import { AgentStateClient } from '../../../../services/agentState/AgentStateClient';
import type { AgentStateSnapshot } from '../../../../shared/agentState/AgentStateSnapshot';

const { send, handle, removeHandler } = vi.hoisted(() => ({ send: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] },
  ipcMain: { handle, removeHandler },
}));

import { AgentStatePublisher } from '../../../../main/AgentStatePublisher';

class PublisherStore implements AgentStateStore {
  readonly durable = new Map<string, AgentJob>();
  constructor(jobs: AgentJob[]) { jobs.forEach(job => this.durable.set(job.jobId, structuredClone(job))); }
  async allJobs(): Promise<AgentJob[]> { return [...this.durable.values()].map(job => structuredClone(job)); }
  async job(jobId: string): Promise<AgentJob | undefined> {
    const job = this.durable.get(jobId); return job ? structuredClone(job) : undefined;
  }
  async jobsForList(limit: number, includeFinished: boolean): Promise<AgentJob[]> {
    const jobs = (await this.allJobs()).filter(job => !job.dismissedAt).sort((a, b) => b.createdAt - a.createdAt);
    return [...jobs.filter(job => ['running', 'parked'].includes(job.status)),
      ...(includeFinished ? jobs.filter(job => !['running', 'parked'].includes(job.status)).slice(0, limit) : [])];
  }
  async insertJob(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)); }
  async replaceState(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)); }
  async replaceStateIfActivityUnchanged(job: AgentJob): Promise<boolean> { await this.replaceState(job); return true; }
  async cascadeJobs(jobId: string): Promise<AgentJob[]> {
    const root = this.durable.get(jobId); if (!root) return [];
    const threads = new Set(root.tasks.flatMap(task => task.threadId ? [task.threadId] : []));
    const found: AgentJob[] = []; let changed = true;
    while (changed) { changed = false; for (const job of this.durable.values()) {
      if (job.jobId !== jobId && (!job.parentThreadId || !threads.has(job.parentThreadId))) continue;
      if (found.some(candidate => candidate.jobId === job.jobId)) continue;
      found.push(structuredClone(job)); job.tasks.forEach(task => { if (task.threadId) threads.add(task.threadId); }); changed = true;
    } }
    return found;
  }
}

const makeJob = (jobId: string, threadId: string, parentThreadId?: string): AgentJob => ({
  jobId, status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, results: [], parentThreadId, visibility: 'hidden',
  tasks: [{ agentId: jobId, label: jobId, prompt: 'work', status: 'running', threadId }],
});

class TestActivitySource {
  private readonly counts = new Map<string, number>();
  private readonly listeners = new Set<(keys: readonly string[]) => void>();
  actionCount(key: string): number { return this.counts.get(key) ?? 0 }
  onChange(listener: (keys: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener) };
  }
  record(key: string, count = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + count);
    for (const listener of this.listeners) listener([key]);
  }
}

describe('AgentStatePublisher', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('reads saved result links by owner after finished lanes expire without exposing prompts', async() => {
    const saved = makeJob('follow', 'worker', 'manager');
    saved.status = 'completed'; saved.finishedAt = 2;
    Object.assign(saved.tasks[0], { status: 'error', completion: { status: 'completed' }, finishedAt: 2, returnedAt: 2, followUpOf: { jobId: 'old', taskIndex: 0 }, decisionIds: ['q'] });
    const store = new PublisherStore([saved, makeJob('other', 'other-worker', 'another-manager')]);
    const states = new AgentStateService(store, { jobs: new Map() }, () => 1_000_000);
    const publisher = new AgentStatePublisher(states, new AgentStateProjector(states, { latest: () => Promise.resolve(null) }, () => 1_000_000));
    publisher.register();
    const read = handle.mock.calls.find(call => call[0] === 'agents:result-tracking')![1];
    const result = await read({}, 'manager');
    expect(result).toEqual([{ jobId: 'follow', taskIndex: 0, threadId: 'worker', status: 'completed', followUpOf: { jobId: 'old', taskIndex: 0 }, decisionIds: ['q'] }]);
    expect(JSON.stringify(result)).not.toContain('prompt');
    expect(store.durable.get('follow')!.tasks[0].status).toBe('error');
    publisher.dispose();
  });

  it('shares slow IPC and event snapshots and publishes a trailing update', async() => {
    vi.useFakeTimers();
    const states = new AgentStateService(new PublisherStore([]), { jobs: new Map() });
    const projector = new AgentStateProjector(states, { latest: async() => null });
    let release!: (snapshot: Awaited<ReturnType<typeof projector.snapshot>>) => void;
    const read = vi.spyOn(projector, 'snapshot').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const publisher = new AgentStatePublisher(states, projector, 10);
    publisher.register();
    const ipcRead = handle.mock.calls.at(-1)![1] as () => ReturnType<typeof projector.snapshot>;
    const requested = ipcRead();
    states.touch();
    await vi.advanceTimersByTimeAsync(10);
    states.touch();
    states.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(1);
    release({ version: 1, generatedAt: new Date(0).toISOString(), rows: [] });
    await requested;
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1].version).toBe(states.version);
    publisher.dispose();
  });

  it('retries an older IPC snapshot when the change arrived before publish started', async() => {
    vi.useFakeTimers();
    const states = new AgentStateService(new PublisherStore([]), { jobs: new Map() }, () => 1);
    const projector = new AgentStateProjector(states, { latest: async() => null });
    let release!: (snapshot: Awaited<ReturnType<typeof projector.snapshot>>) => void;
    const read = vi.spyOn(projector, 'snapshot').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const publisher = new AgentStatePublisher(states, projector, 10);
    publisher.register();
    const ipcRead = handle.mock.calls.at(-1)![1] as () => ReturnType<typeof projector.snapshot>;
    const requested = ipcRead();
    await vi.advanceTimersByTimeAsync(0);
    states.touch();
    await vi.advanceTimersByTimeAsync(10);
    release({ version: 1, generatedAt: new Date(0).toISOString(), rows: [] });
    await requested;
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(call => call[1].version)).toEqual([1, states.version]);
    publisher.dispose();
  });

  it('does not deliver an outstanding snapshot after disposal', async() => {
    vi.useFakeTimers();
    const states = new AgentStateService(new PublisherStore([]), { jobs: new Map() });
    const projector = new AgentStateProjector(states, { latest: async() => null });
    let release!: (snapshot: Awaited<ReturnType<typeof projector.snapshot>>) => void;
    vi.spyOn(projector, 'snapshot').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const publisher = new AgentStatePublisher(states, projector, 10);
    publisher.register();
    states.touch();
    await vi.advanceTimersByTimeAsync(10);
    publisher.dispose();
    release({ version: 1, generatedAt: new Date(0).toISOString(), rows: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();
  });

  it('publishes one coalesced snapshot after a manager cascade stops every descendant', async() => {
    // risk: a cascade emits partial trees or duplicate renderer updates
    vi.useFakeTimers();
    const store = new PublisherStore([
      makeJob('manager', 'manager-thread'),
      makeJob('worker', 'worker-thread', 'manager-thread'),
      makeJob('grandchild', 'grandchild-thread', 'worker-thread'),
    ]);
    const states = new AgentStateService(store, { jobs: new Map() });
    const projector = new AgentStateProjector(states, { latest: async() => null });
    const publisher = new AgentStatePublisher(states, projector, 10);
    publisher.register();

    expect(await states.stopCascade('manager')).toEqual(['manager', 'worker', 'grandchild']);
    await vi.advanceTimersByTimeAsync(10);

    expect(send).toHaveBeenCalledTimes(1);
    const snapshot = send.mock.calls[0][1];
    expect(snapshot.rows.map((row: { state: string }) => row.state)).toEqual(['stopped', 'stopped', 'stopped']);
    publisher.dispose();
  });

  it('coalesces activity pushes without losing cumulative action counts and advances the accepted version', async() => {
    // risk: many discrete actions collapse between snapshots or equal-version pushes are rejected
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const states = new AgentStateService(new PublisherStore([makeJob('worker', 'worker-thread', 'root')]), { jobs: new Map() }, () => Date.now());
    const projector = new AgentStateProjector(states, { latest: async() => null }, () => Date.now());
    const activity = new TestActivitySource();
    const publisher = new AgentStatePublisher(states, projector, 10, activity, 1_000);
    publisher.register();
    const client = new AgentStateClient({} as any, {} as any);
    expect(client.apply({ version: states.version, generatedAt: new Date().toISOString(), rows: [] })).toBe(true);
    const initialVersion = states.version;

    activity.record('worker#0', 3);
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(1);
    const first = send.mock.calls[0][1] as AgentStateSnapshot;
    expect(first.rows[0].actionCount).toBe(3);
    expect(first.version).toBeGreaterThan(initialVersion);
    expect(client.apply(first)).toBe(true);

    activity.record('worker#0', 2);
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);
    activity.record('worker#0', 1);
    await vi.advanceTimersByTimeAsync(510);

    expect(send).toHaveBeenCalledTimes(2);
    const second = send.mock.calls[1][1] as AgentStateSnapshot;
    expect(second.rows[0].actionCount).toBe(6);
    expect(second.version).toBeGreaterThan(first.version);
    expect(client.apply(second)).toBe(true);
    expect(client.apply(second)).toBe(false);
    publisher.dispose();
  });
});
