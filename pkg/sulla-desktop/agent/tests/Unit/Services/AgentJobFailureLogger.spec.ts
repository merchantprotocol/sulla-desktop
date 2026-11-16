// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { AgentJobFailureLogger } from '../../../app/Services/AgentJobFailureLogger';
import { AgentJobMutationQueue, AgentStateService, type AgentStateStore } from '../../../app/Services/AgentStateService';
import { JobRuntimeRegistry } from '../../../app/Services/JobRuntimeRegistry';
import { JobStopService } from '../../../app/Services/JobStopService';
import { StopPrincipal } from '../../../app/ValueObjects/StopPrincipal';
import type { AgentJob, AgentJobResult, AgentJobTask } from '../../../tools/agents/jobRegistry';

class InMemoryStore implements AgentStateStore {
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

class CapturingSink { readonly lines: string[] = []; error(message: string): void { this.lines.push(message); } }

const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask => ({ agentId: 'opus-worker', label: 'Worker', prompt: 'work', status: 'running', startedAt: 1_000,
  threadId: 'thread-child', runLocation: 'container', provider: 'claude-code', model: 'claude-opus-5-5', ...overrides });
const job = (tasks: AgentJobTask[], overrides: Partial<AgentJob> = {}): AgentJob => ({ jobId: 'job-1', status: 'running', createdAt: 500, finishedAt: null,
  taskCount: tasks.length, results: [], tasks, parentJobId: 'job-parent', parentThreadId: 'thread-parent', ...overrides });
const result = (status: AgentJobResult['status'], output: string): AgentJobResult => ({ label: 'Worker', status, output, threadId: 'thread-child', contract: 'result' });

function harness(jobs: AgentJob[]) {
  const sink = new CapturingSink(); const runtime = new JobRuntimeRegistry();
  const states = new AgentStateService(new InMemoryStore(jobs), runtime, () => 10_000, new AgentJobMutationQueue(), new AgentJobFailureLogger(sink));
  for (const item of jobs) runtime.jobs.set(item.jobId, structuredClone(item));
  const stops = new JobStopService(states, runtime, { now: () => new Date(9_000) } as never, {} as never);
  const parsed = () => sink.lines.map(line => {
    expect(line.startsWith(`${ AgentJobFailureLogger.TAG } {`)).toBe(true);
    return JSON.parse(line.slice(AgentJobFailureLogger.TAG.length + 1));
  });
  return { sink, states, stops, parsed };
}

/** Mirrors AgentJobService.recordTaskCompletion: the settled result lands on its task. */
const settle = (states: AgentStateService, taskIndex: number, settled: AgentJobResult) => states.mutateJob('job-1', current => {
  current.results[taskIndex] = settled;
  current.tasks[taskIndex] = { ...current.tasks[taskIndex], status: settled.status, finishedAt: 6_000, completion: settled };
  return current;
});

describe('AgentJobFailureLogger at the job write boundary', () => {
  it('writes exactly one structured background-log line when a task fails', async() => {
    // risk: harness failures that kill workers are invisible in background.log
    const { states, parsed } = harness([job([task()])]);
    const stack = 'Error: provider transport closed\n    at Stream.onClose (CliAgentService.ts:394:11)\n    at next (node:internal)';
    await settle(states, 0, result('error', stack));
    const lines = parsed();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ jobId: 'job-1', taskIndex: 0, agentId: 'opus-worker', label: 'Worker', parentJobId: 'job-parent', threadId: 'thread-child',
      runLocation: 'container', provider: 'claude-code', model: 'claude-opus-5-5', status: 'error', reason: 'provider_transport',
      error: 'Error: provider transport closed', elapsedMs: 5_000 });
    expect(lines[0].stack).toContain('CliAgentService.ts:394');
  });

  it('logs nothing for a completed task', async() => {
    // risk: noise drowns real failures and inflates failure counts
    const { states, sink } = harness([job([task()])]);
    await settle(states, 0, result('completed', 'done'));
    expect(sink.lines).toEqual([]);
  });

  it('does not log the same failure twice when later writes rewrite the failed task', async() => {
    // risk: double counting when failJob/completeJob follow recordTaskCompletion
    const { states, parsed } = harness([job([task(), task({ label: 'Sibling', threadId: 'thread-sibling' })])]);
    await settle(states, 0, result('error', 'Delegated wake turn produced no assistant output after retry: job=job-1'));
    // AgentJobService.failJob re-marks every running/error task; only the sibling newly fails.
    await states.mutateJob('job-1', current => ({ ...current, status: 'failed', error: 'tool call deadline exceeded',
      tasks: current.tasks.map(item => ['running', 'error'].includes(item.status) ? { ...item, status: 'error', finishedAt: 7_000,
        completion: item.completion ?? result('error', 'tool call deadline exceeded') } : item) }));
    expect(parsed().map(line => [line.taskIndex, line.reason])).toEqual([[0, 'empty_wake'], [1, 'deadline']]);
  });

  it('logs a dead-run watcher kill once and ignores a human stop', async() => {
    // risk: system kills are unaccounted while deliberate stops pollute the failure log
    const killed = harness([job([task()])]);
    expect(killed.stops.abortJob('job-1', StopPrincipal.system('SpawnAgentDeadRunWatcher'), 'dead run: no activity for 900s')).toBe('stopped');
    await killed.states.mutateJob('job-1', current => current);
    expect(killed.parsed()).toEqual([expect.objectContaining({ status: 'stopped', reason: 'dead_run', stoppedBy: 'SpawnAgentDeadRunWatcher', error: 'dead run: no activity for 900s' })]);

    const human = harness([job([task()])]);
    expect(await human.stops.stopTask('job-1', 0, StopPrincipal.human(), 'not needed')).toBe('stopped');
    expect(human.sink.lines).toEqual([]);
  });
});
