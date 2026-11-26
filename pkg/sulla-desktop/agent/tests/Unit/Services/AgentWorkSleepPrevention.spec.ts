// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AgentWorkSleepPrevention } from '../../../app/Services/AgentWorkSleepPrevention';
import { AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

class InMemoryAgentJobStore implements AgentStateStore {
  private readonly durable = new Map<string, AgentJob>();

  constructor(jobs: AgentJob[] = []) { for (const job of jobs) this.durable.set(job.jobId, structuredClone(job)); }
  async allJobs(): Promise<AgentJob[]> { return [...this.durable.values()].map(job => structuredClone(job)); }
  async job(jobId: string): Promise<AgentJob | undefined> { const job = this.durable.get(jobId); return job && structuredClone(job) }
  async jobsForList(limit: number, includeFinished: boolean): Promise<AgentJob[]> {
    const jobs = await this.allJobs();
    const active = jobs.filter(job => ['running', 'parked'].includes(job.status));
    return includeFinished ? [...active, ...jobs.filter(job => !['running', 'parked'].includes(job.status)).slice(0, limit)] : active;
  }
  async insertJob(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)); }
  async replaceState(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)); }
  async cascadeJobs(jobId: string): Promise<AgentJob[]> { const job = await this.job(jobId); return job ? [job] : [] }
  async replaceStateIfActivityUnchanged(job: AgentJob): Promise<boolean> { this.durable.set(job.jobId, structuredClone(job)); return true }
}

const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask => ({ agentId: 'worker', label: 'Worker', prompt: 'work', status: 'running', ...overrides });
const job = (jobId: string): AgentJob => ({ jobId, status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, results: [], tasks: [task()], visibility: 'hidden' });

function stateHarness(jobs: AgentJob[] = []) {
  const store = new InMemoryAgentJobStore(jobs);
  return { store, states: new AgentStateService(store, { jobs: new Map() }) };
}

describe('agent work sleep prevention', () => {
  it('acquires the hold when the first running job starts', async() => {
    // risk: an active delegated worker lets the Mac sleep before it can finish.
    const { states } = stateHarness();
    const start = vi.fn(), stop = vi.fn();
    const work = new AgentWorkSleepPrevention(states, { startCaffeinate: start, stopCaffeinate: stop });

    await states.create(job('job-a'));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('agent-work');
    expect(stop).not.toHaveBeenCalled();
  });

  it('keeps the hold while any running job remains and releases after the last one ends', async() => {
    // risk: finishing one worker releases sleep prevention while a sibling worker is still running.
    const { states } = stateHarness();
    const start = vi.fn(), stop = vi.fn();
    const work = new AgentWorkSleepPrevention(states, { startCaffeinate: start, stopCaffeinate: stop });

    await states.create(job('job-a'));
    await states.create(job('job-b'));
    await states.update('job-a', current => ({ ...current, tasks: current.tasks.map(child => ({ ...child, status: 'completed' })) }));
    expect(stop).not.toHaveBeenCalled();
    await states.update('job-b', current => ({ ...current, tasks: current.tasks.map(child => ({ ...child, status: 'completed' })) }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not start or stop the same keyed hold twice for duplicate state events', async() => {
    // risk: duplicate notifications leak caffeinate holders or stop another active run's hold.
    const { states } = stateHarness();
    const start = vi.fn(), stop = vi.fn();
    const work = new AgentWorkSleepPrevention(states, { startCaffeinate: start, stopCaffeinate: stop });

    await states.create(job('same-job'));
    await states.create(job('same-job'));
    work.chatRunStarted('graph:one');
    work.chatRunStarted('graph:one');
    expect(start).toHaveBeenCalledTimes(1);
    await states.update('same-job', current => ({ ...current, tasks: current.tasks.map(child => ({ ...child, status: 'completed' })) }));
    expect(stop).not.toHaveBeenCalled();
    work.chatRunEnded('graph:one');
    work.chatRunEnded('graph:one');
    expect(stop).toHaveBeenCalledTimes(1);

    work.chatRunStarted('graph:two');
    work.chatRunEnded('graph:two');
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('re-evaluates durable running jobs after startup recovery', async() => {
    // risk: after restart, no new state transition arrives to acquire the lost process-local sleep hold.
    const { states } = stateHarness([job('recovered-job')]);
    const start = vi.fn(), stop = vi.fn();
    const work = new AgentWorkSleepPrevention(states, { startCaffeinate: start, stopCaffeinate: stop });

    expect(start).not.toHaveBeenCalled();
    await work.reconcileAfterRecovery();
    await work.reconcileAfterRecovery();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('agent-work');
    expect(stop).not.toHaveBeenCalled();
  });
});
