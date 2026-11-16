// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

class InMemoryAgentStateStore implements AgentStateStore {
  readonly durable = new Map<string, AgentJob>();
  constructor(jobs: AgentJob[]) { for (const job of jobs) this.durable.set(job.jobId, structuredClone(job)); }
  async allJobs(): Promise<AgentJob[]> { return Array.from(this.durable.values()).map(job => structuredClone(job)); }
  async job(jobId: string): Promise<AgentJob | undefined> { const job = this.durable.get(jobId); return job ? structuredClone(job) : undefined; }
  async jobsForList(): Promise<AgentJob[]> { return this.allJobs(); }
  async insertJob(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)); }
  async replaceState(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)); }
  async cascadeJobs(jobId: string): Promise<AgentJob[]> { const job = this.durable.get(jobId); return job ? [structuredClone(job)] : []; }
  async replaceStateIfActivityUnchanged(job: AgentJob): Promise<boolean> { this.durable.set(job.jobId, structuredClone(job)); return true; }
}

const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask => ({ agentId: 'opus-worker', label: 'Worker', prompt: 'work', status: 'running', startedAt: 1_000, ...overrides });
const job = (jobId: string, tasks: AgentJobTask[], overrides: Partial<AgentJob> = {}): AgentJob => ({ jobId, status: 'running', createdAt: 1_000, finishedAt: null, taskCount: tasks.length, results: [], tasks, visibility: 'hidden', ...overrides });

function harness(jobs: AgentJob[], now = 50_000) {
  const store = new InMemoryAgentStateStore(jobs);
  return { store, states: new AgentStateService(store, { jobs: new Map() }, () => now) };
}

describe('terminal job rollup stamps finishedAt', () => {
  it('stamps finishedAt from the task finish time when a task settling as error fails the job', async() => {
    // risk: data accuracy - a failed job persisted with finished_at NULL looks unfinished in history and elapsed time
    const { states, store } = harness([job('agent-job-1', [task()])]);
    await states.transition('agent-job-1', 0, { status: 'error', finishedAt: 4_045 });
    const durable = store.durable.get('agent-job-1')!;
    expect(durable.status).toBe('failed');
    expect(durable.finishedAt).toBe(4_045);
  });

  it('stamps finishedAt when the last task completes and the job rolls up to completed', async() => {
    // risk: data accuracy - completed jobs never get a finish time, so retention pruning never ages them out
    const { states, store } = harness([job('agent-job-2', [task({ status: 'completed', finishedAt: 3_000 }), task()])]);
    await states.transition('agent-job-2', 1, { status: 'completed', finishedAt: 7_000 });
    expect(store.durable.get('agent-job-2')).toMatchObject({ status: 'completed', finishedAt: 7_000 });
  });

  it('uses the clock when the settling task carries no finish time', async() => {
    // risk: data accuracy - a terminal job without any task timestamps must still be stamped
    const { states, store } = harness([job('agent-job-3', [task()])], 42_000);
    await states.transition('agent-job-3', 0, { status: 'error' });
    expect(store.durable.get('agent-job-3')).toMatchObject({ status: 'failed', finishedAt: 42_000 });
  });

  it('keeps an existing job finishedAt and leaves live jobs unfinished', async() => {
    // risk: re-deriving status must not move an already-recorded finish time or finish a running job
    const { states, store } = harness([
      job('agent-job-4', [task()]),
      job('agent-job-5', [task(), task()]),
    ]);
    await states.transition('agent-job-4', 0, { status: 'error', finishedAt: 9_000 }, { finishedAt: 5_000 });
    await states.transition('agent-job-5', 0, { status: 'error', finishedAt: 9_000 });
    expect(store.durable.get('agent-job-4')).toMatchObject({ status: 'failed', finishedAt: 5_000 });
    expect(store.durable.get('agent-job-5')).toMatchObject({ status: 'running', finishedAt: null });
  });

  it('repairs an already-persisted failed job with no finishedAt when it is read', async() => {
    // risk: data accuracy - rows written before the fix (agent-job-1794841591558-186) stay unfinished forever
    const legacy = job('agent-job-6', [task({ status: 'error', finishedAt: 4_045 })], { status: 'failed' });
    const { states, store } = harness([legacy]);
    expect((await states.job('agent-job-6'))?.finishedAt).toBe(4_045);
    expect(store.durable.get('agent-job-6')?.finishedAt).toBe(4_045);
  });
});
