// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentTabPromoter, type PromotableJobStore } from '../../../services/AgentTabPromoter';
import type { AgentJob } from '../../../tools/agents/jobRegistry';
import { StopPrincipal } from '../../../app/ValueObjects/StopPrincipal';

const runningJob = (overrides: Partial<AgentJob> = {}): AgentJob => ({
  jobId: 'job-1', status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, results: [], parentThreadId: 'human-chat', parentAgentId: 'coding-manager', visibility: 'hidden',
  tasks: [{ agentId: 'codex-sol-worker', label: 'Fix', prompt: 'do it', status: 'running', threadId: 'child-thread', visibility: 'hidden', depth: 1 }],
  ...overrides,
} as AgentJob);

class FakeJobStore implements PromotableJobStore {
  marked: number[] = [];
  constructor(private job: AgentJob | undefined, private authorization: 'allowed' | 'not-found' | 'forbidden' = 'allowed') {}
  async getJob() { return this.job; }
  async authorize() { return this.authorization; }
  async markTaskPromoted(_jobId: string, taskIndex: number) {
    this.marked.push(taskIndex);
    this.job = { ...this.job!, tasks: this.job!.tasks.map((task, index) => index === taskIndex ? { ...task, promotedToTab: true } : task) };
    return this.job.tasks[taskIndex];
  }
}

const parent = StopPrincipal.agent('coding-manager', 'human-chat')!;
const stranger = StopPrincipal.agent('unrelated-agent', 'other-thread')!;

describe('AgentTabPromoter', () => {
  it('refuses a caller that is not an ancestor and opens nothing', async() => {
    // risk: any agent could pull another team's worker into a visible tab
    const store = new FakeJobStore(runningJob(), 'forbidden');
    const opened: unknown[] = [];
    const result = await new AgentTabPromoter(store, (...args) => { opened.push(args); return true; }).promote('job-1', 0, stranger);
    expect(result.successBoolean).toBe(false);
    expect(result.error).toMatch(/only its ancestors or the human/);
    expect(opened).toHaveLength(0);
    expect(store.marked).toHaveLength(0);
  });

  it('lets the parent promote: binds the existing thread, marks promotedToTab, and returns the tab id', async() => {
    // risk: promotion restarts the child or loses the thread history it already has
    const store = new FakeJobStore(runningJob());
    const opened: Array<{ threadId: string; taskIndex: number; focus: boolean }> = [];
    const result = await new AgentTabPromoter(store, (job, taskIndex, focus) => {
      opened.push({ threadId: job.tasks[taskIndex].threadId!, taskIndex, focus });
      return true;
    }).promote('job-1', undefined, parent);
    expect(result).toEqual({ successBoolean: true, tabId: 'job-1#0', alreadyVisible: false });
    expect(opened).toEqual([{ threadId: 'child-thread', taskIndex: 0, focus: false }]);
    expect(store.marked).toEqual([0]);
  });

  it('does not mark the task promoted when the renderer cannot open the tab', async() => {
    // risk: the rail shows a tab that never opened
    const store = new FakeJobStore(runningJob());
    const result = await new AgentTabPromoter(store, () => false).promote('job-1', 0, parent);
    expect(result.successBoolean).toBe(false);
    expect(store.marked).toHaveLength(0);
  });

  it('refuses a task that already finished, and a task with no thread', async() => {
    // risk: opening a finished or thread-less task shows an empty or stale tab
    const finished = new FakeJobStore(runningJob({ tasks: [{ ...runningJob().tasks[0], status: 'completed' }] } as Partial<AgentJob>));
    expect((await new AgentTabPromoter(finished, () => true).promote('job-1', 0, parent)).successBoolean).toBe(false);
    const noThread = new FakeJobStore(runningJob({ tasks: [{ ...runningJob().tasks[0], threadId: undefined }] } as Partial<AgentJob>));
    expect((await new AgentTabPromoter(noThread, () => true).promote('job-1', 0, parent)).successBoolean).toBe(false);
  });

  it('is idempotent for an already promoted task: reopens the tab without remarking', async() => {
    // risk: a second click double-marks or fails the task
    const promoted = new FakeJobStore(runningJob({ tasks: [{ ...runningJob().tasks[0], promotedToTab: true }] } as Partial<AgentJob>));
    const result = await new AgentTabPromoter(promoted, () => true).promote('job-1', 0, parent);
    expect(result).toEqual({ successBoolean: true, tabId: 'job-1#0', alreadyVisible: true });
    expect(promoted.marked).toHaveLength(0);
  });

  it('rejects a missing job and a negative task index', async() => {
    // risk: a bad index promotes a neighbouring task
    expect((await new AgentTabPromoter(new FakeJobStore(undefined, 'not-found'), () => true).promote('nope', 0, parent)).successBoolean).toBe(false);
    expect((await new AgentTabPromoter(new FakeJobStore(runningJob()), () => true).promote('job-1', -1, parent)).successBoolean).toBe(false);
  });
});
