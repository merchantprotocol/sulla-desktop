// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import { JobRuntimeRegistry } from '../../../app/Services/JobRuntimeRegistry';
import { JobStopService } from '../../../app/Services/JobStopService';
import { StopPrincipal } from '../../../app/ValueObjects/StopPrincipal';
import { AbortService } from '../../../services/AbortService';
import { AbortSignalBridge } from '../../../app/Services/AbortSignalBridge';
import { RecoveredAgentTaskDispatcher } from '../../../services/RecoveredAgentTaskDispatcher';
import type { AgentJob } from '../../../tools/agents/jobRegistry';

class InMemoryJobs implements AgentStateStore {
  private readonly rows = new Map<string, AgentJob>();
  constructor(job: AgentJob) { this.rows.set(job.jobId, structuredClone(job)) }
  async allJobs(): Promise<AgentJob[]> { return [...this.rows.values()].map(row => structuredClone(row)) }
  async job(jobId: string): Promise<AgentJob | undefined> { const row = this.rows.get(jobId); return row && structuredClone(row) }
  async jobsForList(): Promise<AgentJob[]> { return this.allJobs() }
  async insertJob(job: AgentJob): Promise<void> { this.rows.set(job.jobId, structuredClone(job)) }
  async replaceState(job: AgentJob): Promise<void> { this.rows.set(job.jobId, structuredClone(job)) }
  async cascadeJobs(jobId: string): Promise<AgentJob[]> { const job = await this.job(jobId); return job ? [job] : [] }
  async replaceStateIfActivityUnchanged(job: AgentJob): Promise<boolean> { await this.replaceState(job); return true }
}

const runningJob = (): AgentJob => ({
  jobId: 'recovered-job', status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, results: [], visibility: 'hidden',
  tasks: [{ agentId: 'worker', label: 'Worker', prompt: 'continue', status: 'running', threadId: 'recovered-thread' }],
});

function harness(job = runningJob()) {
  const store = new InMemoryJobs(job);
  const states = new AgentStateService(store, { jobs: new Map() }, () => 2);
  const runtime = new JobRuntimeRegistry();
  const stops = new JobStopService(states, runtime, { now: () => new Date(3) } as never, {} as never);
  const jobs = {
    getJob: (id: string) => states.job(id),
    ensureTaskAbortSignal: (id: string, index: number) => runtime.ensureAbortScope(id).taskSignal(index),
  };
  const dispatcher = new RecoveredAgentTaskDispatcher(jobs, async() => undefined);
  return { store, states, runtime, stops, jobs, dispatcher };
}

describe('RecoveredAgentTaskDispatcher', () => {
  it('does not dispatch a claimed running snapshot after a stop wins the race', async() => {
    // risk: lifecycle — an owner stop must not be undone by a stale restart snapshot.
    const { stops, jobs } = harness();
    const claimed = runningJob();
    const dispatch = vi.fn(async() => undefined);
    const gate = new RecoveredAgentTaskDispatcher(jobs, dispatch);

    await stops.stopTask(claimed.jobId, 0, StopPrincipal.human(), 'stopped during restart');
    expect(await gate.dispatchIfRunning(claimed, 0, async() => undefined)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('aborts the recovered graph signal when a running task is stopped', async() => {
    // risk: lifecycle — a resumed worker's current graph must obey a durable task stop.
    const { stops, jobs } = harness();
    const dispatch = vi.fn(async(_job: AgentJob, _index: number, controller: AbortController) => {
      const graphRun = new AbortService();
      const bridge = new AbortSignalBridge(controller.signal, graphRun);
      await stops.stopTask('recovered-job', 0, StopPrincipal.human(), 'stop resumed run');
      expect(controller.signal.aborted).toBe(true);
      expect(graphRun.signal.aborted).toBe(true);
      bridge.dispose();
    });
    const gate = new RecoveredAgentTaskDispatcher(jobs, dispatch);

    expect(await gate.dispatchIfRunning(runningJob(), 0, async() => undefined)).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
