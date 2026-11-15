// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { AgentJobLifecycleService } from '../../../services/AgentJobLifecycleService';
import { ReturnedTaskSettlement } from '../../../services/ReturnedTaskSettlement';

import type { AgentJob, AgentJobResult, AgentJobTask } from '../../../tools/agents/jobRegistry';

/** In-memory job store with the same running->parked guard as AgentJobService.parkJobTask. */
class MemoryJobs {
  readonly delivered: { jobId: string; taskIndex: number; results: AgentJobResult[] }[] = [];
  readonly completed: { jobId: string; results: AgentJobResult[] }[] = [];
  constructor(readonly jobs: AgentJob[]) {}
  job(jobId: string) { return this.jobs.find(job => job.jobId === jobId) }
  park(jobId: string, taskIndex: number): Promise<boolean> {
    const task = this.job(jobId)?.tasks[taskIndex];
    if (task?.status !== 'running') return Promise.resolve(false);
    task.status = 'parked';
    return Promise.resolve(true);
  }

  settlement(liveRunnerThreads: string[] = []) {
    return new ReturnedTaskSettlement({
      getJob:               jobId => Promise.resolve(this.job(jobId)),
      liveJobs:             () => Promise.resolve(this.jobs.filter(job => ['running', 'parked'].includes(job.status))),
      resultFor:            (task, label, threadId) => ({ label, status: 'completed', output: JSON.stringify(task.result), threadId, contract: 'result', result: task.result }),
      recordTaskCompletion: (jobId, taskIndex, result) => {
        const job = this.job(jobId)!;
        job.results[taskIndex] = result;
        job.tasks[taskIndex] = { ...job.tasks[taskIndex], status: result.status, completion: result, finishedAt: 1 };
        return Promise.resolve();
      },
      deliver:       (job, results, taskIndex) => { this.delivered.push({ jobId: job.jobId, taskIndex, results }); return Promise.resolve(true) },
      completeJob:   (jobId, results) => { this.completed.push({ jobId, results }); this.job(jobId)!.status = 'completed'; return Promise.resolve() },
      hasLiveRunner: threadId => liveRunnerThreads.includes(threadId),
    });
  }
}

function task(overrides: Partial<AgentJobTask>): AgentJobTask {
  return { agentId: 'codex-sol-worker', prompt: 'merge the train', label: 'Merge train', threadId: 'spawn-agent-merge-train-0', status: 'running', ...overrides } as AgentJobTask;
}

function job(tasks: AgentJobTask[], status: AgentJob['status'] = 'running'): AgentJob {
  return { jobId: 'agent-job-merge-train', status, createdAt: 0, finishedAt: null, taskCount: tasks.length, results: [], tasks, parentChannel: 'sulla-desktop', parentThreadId: 'orchestrator-thread' } as AgentJob;
}

function lifecycle(store: MemoryJobs, liveRunnerThreads: string[] = []) {
  const settlement = store.settlement(liveRunnerThreads);
  return new AgentJobLifecycleService({ openChildrenForThread: () => Promise.resolve(0) }, (jobId, taskIndex) => store.park(jobId, taskIndex), vi.fn(), (jobId, taskIndex) => settlement.settle(jobId, taskIndex));
}

describe('dormant wake turn that calls return_result', () => {
  it('delivers the returned contract to the parent instead of re-parking the task forever', async() => {
    // risk (2026-11-15 merge train): a timer woke a dormant parked worker, it called
    // return_result, and the turn's end re-parked it. Nothing ever woke it again,
    // so the parent never received the result and the job stayed parked.
    const store = new MemoryJobs([job([task({ status: 'running', returnedAt: 1_000, result: { merges: 11 } })])]);

    await lifecycle(store).endDormantWakeTurn('agent-job-merge-train', 0);

    const settled = store.job('agent-job-merge-train')!;
    expect(settled.tasks[0].status).toBe('completed');
    expect(store.delivered).toEqual([{ jobId: 'agent-job-merge-train', taskIndex: 0, results: [expect.objectContaining({ status: 'completed', result: { merges: 11 } })] }]);
    expect(store.completed).toHaveLength(1);
    expect(settled.status).toBe('completed');
  });

  it('still re-parks a woken task that ended its turn without returning', async() => {
    // risk: settling would close a job whose worker is still waiting on external work
    const store = new MemoryJobs([job([task({ status: 'running' })])]);

    await lifecycle(store).endDormantWakeTurn('agent-job-merge-train', 0);

    expect(store.job('agent-job-merge-train')!.tasks[0].status).toBe('parked');
    expect(store.delivered).toEqual([]);
  });

  it('leaves settlement to a live spawn_agent runner that still owns the thread', async() => {
    // risk: the parent receives the same contract twice, once from here and once from the runner
    const store = new MemoryJobs([job([task({ status: 'running', returnedAt: 1_000, result: {} })])]);

    await lifecycle(store, ['spawn-agent-merge-train-0']).endDormantWakeTurn('agent-job-merge-train', 0);

    expect(store.delivered).toEqual([]);
    expect(store.completed).toEqual([]);
  });

  it('delivers one sibling but keeps the job open while another sibling is still parked', async() => {
    // risk: closing a multi-task job early drops the result of a sibling still at work
    const store = new MemoryJobs([job([
      task({ status: 'running', returnedAt: 1_000, result: { done: true } }),
      task({ status: 'parked', threadId: 'spawn-agent-sibling-1', label: 'Sibling' }),
    ])]);

    await lifecycle(store).endDormantWakeTurn('agent-job-merge-train', 0);

    expect(store.delivered).toHaveLength(1);
    expect(store.completed).toEqual([]);
    expect(store.job('agent-job-merge-train')!.status).toBe('running');
  });

  it('re-parks instead of throwing out of the dispatch finally block when settlement fails', async() => {
    // risk: an exception here skips the rest of dispatchToAgent's cleanup (abort keys, inbox flush)
    const store = new MemoryJobs([job([task({ status: 'running', returnedAt: 1_000, result: {} })])]);
    const service = new AgentJobLifecycleService({ openChildrenForThread: () => Promise.resolve(0) }, (jobId, taskIndex) => store.park(jobId, taskIndex), vi.fn(), () => Promise.reject(new Error('db down')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(service.endDormantWakeTurn('agent-job-merge-train', 0)).resolves.toBeUndefined();

    expect(store.job('agent-job-merge-train')!.tasks[0].status).toBe('parked');
    warn.mockRestore();
  });
});

describe('startup sweep for returns left without a runner', () => {
  it('settles tasks that were re-parked with a recorded return before this fix', async() => {
    // risk: the three jobs already stranded on 2026-11-13/14/15 (parked + returnedAt, no completion) stay stuck forever
    const store = new MemoryJobs([
      job([task({ status: 'parked', returnedAt: 1_000, result: { merges: 11 } })], 'parked'),
      { ...job([task({ status: 'parked', threadId: 'still-waiting' })], 'parked'), jobId: 'agent-job-still-waiting' },
    ]);

    expect(await store.settlement().settleStranded()).toBe(1);

    expect(store.job('agent-job-merge-train')!.status).toBe('completed');
    expect(store.job('agent-job-still-waiting')!.tasks[0].status).toBe('parked');
    expect(store.delivered.map(entry => entry.jobId)).toEqual(['agent-job-merge-train']);
  });

  it('does not re-deliver a return whose completion was already recorded', async() => {
    // risk: every restart wakes the parent with the same old result again
    const completion = { label: 'Merge train', status: 'completed', output: 'done', threadId: 'spawn-agent-merge-train-0' } as AgentJobResult;
    const store = new MemoryJobs([job([task({ status: 'completed', returnedAt: 1_000, completion })])]);

    expect(await store.settlement().settleStranded()).toBe(0);
    expect(store.delivered).toEqual([]);
  });
});
