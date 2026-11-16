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

function harness(jobs: AgentJob[], sink: CapturingSink = new CapturingSink()) {
  const runtime = new JobRuntimeRegistry(); const store = new InMemoryStore(jobs);
  const states = new AgentStateService(store, runtime, () => 10_000, new AgentJobMutationQueue(), new AgentJobFailureLogger(sink));
  for (const item of jobs) runtime.jobs.set(item.jobId, structuredClone(item));
  const stops = new JobStopService(states, runtime, { now: () => new Date(9_000) } as never, {} as never);
  const parsed = () => sink.lines.map(line => {
    expect(line.startsWith(`${ AgentJobFailureLogger.TAG } {`)).toBe(true);
    return JSON.parse(line.slice(AgentJobFailureLogger.TAG.length + 1));
  });
  return { sink, store, states, stops, parsed };
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
    expect(lines[0].stack).not.toContain('provider transport closed');
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

  it('logs live tasks once when restart recovery exhausts and fails the job without touching its tasks', async() => {
    // risk: a worker killed by restart-recovery exhaustion leaves no trace in background.log
    const { states, parsed } = harness([job([task(), task({ label: 'Done', status: 'completed', finishedAt: 2_000 })], { restartResumeCount: 2 })]);
    const claimed = await states.claimInterruptedJobs(2);
    expect(claimed.exhausted.map(item => item.jobId)).toEqual(['job-1']);
    expect(parsed()).toEqual([expect.objectContaining({ jobId: 'job-1', taskIndex: 0, status: 'running', jobStatus: 'failed',
      reason: 'recovery_exhausted', error: 'runtime restart recovery limit exceeded' })]);
    // A later system stop that finally settles the stranded task must not log it again.
    expect(await states.stopCascade('job-1', StopPrincipal.attribution(StopPrincipal.system('SpawnAgentDeadRunWatcher')), 'dead run: no activity for 900s')).toEqual(['job-1']);
    expect(parsed()).toHaveLength(1);
  });

  it('classifies a liveness-reconciler kill as lost from the task summary', async() => {
    // risk: lost workers are miscounted as generic errors, hiding the reconciler as the killer
    const { states, parsed } = harness([job([task()])]);
    const reason = 'lost: no live graph or container and no activity for 900000ms';
    expect(await states.transitionIfActivityUnchanged('job-1', 0, null, { status: 'error', summary: reason, finishedAt: 7_000 },
      { error: reason, finishedAt: 7_000, waitingOnChildren: 0 })).toBe(true);
    expect(parsed()).toEqual([expect.objectContaining({ taskIndex: 0, status: 'error', reason: 'lost', error: reason, elapsedMs: 6_000 })]);
  });

  it('redacts obvious credentials echoed into the error and stack', async() => {
    // risk: provider errors leak API keys and tokens into background.log
    const { states, sink } = harness([job([task()])]);
    await settle(states, 0, result('error', 'Error: 401 for Bearer FAKEtoken12345678 key sk-FAKE-TEST-12345678\n'
      + '    at call (gh.ts:1:1) ghp_FAKEFAKEFAKE1234 github_pat_FAKE_FAKE_1234 xoxb-FAKE-FAKE-1234'));
    expect(sink.lines).toHaveLength(1);
    for (const secret of ['FAKEtoken12345678', 'sk-FAKE-TEST-12345678', 'ghp_FAKEFAKEFAKE1234', 'github_pat_FAKE_FAKE_1234', 'xoxb-FAKE-FAKE-1234']) {
      expect(sink.lines[0]).not.toContain(secret);
    }
    expect(sink.lines[0]).toContain('[REDACTED]');
  });

  it('never lets a throwing log sink break the job write', async() => {
    // risk: a logging failure loses the durable task failure it was reporting
    const throwing = new CapturingSink(); throwing.error = () => { throw new Error('log disk full'); };
    const { states, store } = harness([job([task()])], throwing);
    const written = await settle(states, 0, result('error', 'Error: boom'));
    expect(written?.tasks[0].status).toBe('error');
    expect(store.durable.get('job-1')?.tasks[0].status).toBe('error');
  });
});
