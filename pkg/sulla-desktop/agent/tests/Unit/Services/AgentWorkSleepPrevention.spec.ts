// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AgentWorkSleepPrevention } from '../../../app/Services/AgentWorkSleepPrevention';
import { AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

class InMemoryAgentJobStore implements AgentStateStore {
  private readonly durable = new Map<string, AgentJob>();
  constructor(jobs: AgentJob[] = []) { for (const job of jobs) this.durable.set(job.jobId, structuredClone(job)) }
  async allJobs(): Promise<AgentJob[]> { return [...this.durable.values()].map(job => structuredClone(job)) }
  async job(jobId: string): Promise<AgentJob | undefined> { const job = this.durable.get(jobId); return job && structuredClone(job) }
  async jobsForList(limit: number, includeFinished: boolean): Promise<AgentJob[]> {
    const jobs = await this.allJobs();
    const active = jobs.filter(job => ['running', 'parked'].includes(job.status));
    return includeFinished ? [...active, ...jobs.filter(job => !['running', 'parked'].includes(job.status)).slice(0, limit)] : active;
  }
  async insertJob(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)) }
  async replaceState(job: AgentJob): Promise<void> { this.durable.set(job.jobId, structuredClone(job)) }
  async cascadeJobs(jobId: string): Promise<AgentJob[]> { const job = await this.job(jobId); return job ? [job] : [] }
  async replaceStateIfActivityUnchanged(job: AgentJob): Promise<boolean> { this.durable.set(job.jobId, structuredClone(job)); return true }
}

const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask => ({ agentId: 'worker', label: 'Worker', prompt: 'work', status: 'running', ...overrides });
const job = (jobId: string, visibility: AgentJob['visibility'] = 'hidden'): AgentJob => ({ jobId, status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, results: [], tasks: [task()], visibility });

function stateHarness(jobs: AgentJob[] = []) {
  const store = new InMemoryAgentJobStore(jobs);
  return { store, states: new AgentStateService(store, { jobs: new Map() }) };
}

function holdHarness() {
  const start = vi.fn(), stop = vi.fn();
  return { start, stop, work: new AgentWorkSleepPrevention({ startCaffeinate: start, stopCaffeinate: stop }) };
}

describe('agent work sleep prevention follows live execution', () => {
  it('does not hold for a running tab job without a live runner', async() => {
    // risk: an open tab job marked running pins the Mac awake while it waits for the human
    const { states } = stateHarness();
    const { start } = holdHarness();
    await states.create(job('tab-job', 'tab'));
    expect(start).not.toHaveBeenCalled();
  });

  it('does not reacquire a hold from a stale running database row at startup', async() => {
    // risk: a zombie row left running for weeks keeps the Mac awake after every restart
    const stale = job('stale-job');
    stale.tasks[0].startedAt = Date.now() - 21 * 24 * 60 * 60_000;
    const { states } = stateHarness([stale]);
    const { start, work } = holdHarness();
    await work.reconcileAfterRecovery();
    expect(await states.job('stale-job')).toMatchObject({ status: 'running' });
    expect(start).not.toHaveBeenCalled();
  });

  it('holds only while a hidden runner or CLI child is live', () => {
    // risk: a running worker is allowed to sleep, or a finished child leaks a hold
    const { start, stop, work } = holdHarness();
    work.hiddenRunnerStarted('task-thread');
    work.cliChildStarted('codex-run');
    expect(start).toHaveBeenCalledTimes(1);
    work.hiddenRunnerEnded('task-thread');
    expect(stop).not.toHaveBeenCalled();
    work.cliChildEnded('codex-run');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('tracks chat runs idempotently from active-abort lifecycle signals', () => {
    // risk: duplicate run registration leaks a sleep hold or ending a sibling releases too early
    const { start, stop, work } = holdHarness();
    work.chatRunStarted('chat-a');
    work.chatRunStarted('chat-a');
    work.chatRunStarted('chat-b');
    expect(start).toHaveBeenCalledTimes(1);
    work.chatRunEnded('chat-a');
    expect(stop).not.toHaveBeenCalled();
    work.chatRunEnded('chat-b');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('releases a chat-run hold after a thrown execution error', async() => {
    // risk: an exception skips the chatRunEnded path and pins the Mac awake
    const { start, stop, work } = holdHarness();
    const run = async() => {
      work.chatRunStarted('throwing-chat');
      try { throw new Error('synthetic graph failure') } finally { work.chatRunEnded('throwing-chat') }
    };
    await expect(run()).rejects.toThrow('synthetic graph failure');
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
