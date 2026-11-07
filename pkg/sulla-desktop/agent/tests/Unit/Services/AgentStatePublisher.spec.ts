// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '../../../tools/agents/jobRegistry';
import { AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import { AgentStateProjector } from '../../../app/Services/AgentStateProjector';

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

describe('AgentStatePublisher', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

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
});
