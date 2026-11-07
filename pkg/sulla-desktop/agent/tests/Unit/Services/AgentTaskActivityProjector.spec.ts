// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentTaskActivityProjector } from '../../../app/Services/AgentTaskActivityProjector';
import type { AgentJob, AgentJobTask } from '../../../tools/agents/jobRegistry';

const now = 1_000_000;
const task = (overrides: Partial<AgentJobTask> = {}): AgentJobTask => ({ agentId: 'worker', label: 'Worker', prompt: 'work', status: 'running', startedAt: 100_000, ...overrides });
const job = (tasks: AgentJobTask[], overrides: Partial<AgentJob> = {}): AgentJob => ({ jobId: 'job', status: 'running', createdAt: 100_000, finishedAt: null, taskCount: tasks.length, results: [], tasks, ...overrides });

class ActivityReader {
  constructor(private readonly activity: Record<string, number>) {}
  lastActivityAt(key: string): number | undefined { return this.activity[key]; }
}

describe('AgentTaskActivityProjector', () => {
  it('uses fresh model/tool activity for the exact task across every presentation state', () => {
    // risk: live drawer says working while snapshot, fleet and directory call the same active task quiet
    const projector = new AgentTaskActivityProjector(new ActivityReader({ 'job#0': 990_000 }), () => now);
    expect(projector.project(job([task()]), task(), 0, { createdAt: 100_000 }).state).toBe('working');
    expect(projector.project(job([task(), task()]), task(), 1, { createdAt: 100_000 })).toMatchObject({ state: 'quiet', lastActivityAt: 100_000 });
  });

  it('keeps genuinely inactive work quiet without overriding blocked or terminal lifecycle state', () => {
    // risk: stale work lies as running, or quiet detection hides an actionable blocker/final state
    const projector = new AgentTaskActivityProjector(new ActivityReader({}), () => now);
    expect(projector.project(job([task()]), task(), 0, { createdAt: 100_000 }).state).toBe('quiet');
    expect(projector.project(job([task({ status: 'blocked' })]), task({ status: 'blocked' }), 0).state).toBe('blocked');
    expect(projector.project(job([task({ status: 'completed' })], { status: 'completed' }), task({ status: 'completed' }), 0).state).toBe('done');
    expect(projector.project(job([task({ status: 'error' })], { status: 'failed', error: 'lost: runtime absent' }), task({ status: 'error' }), 0).state).toBe('lost');
  });

  it('exempts a future wake from quiet classification', () => {
    // risk: an intentional agents/wait sleep is reported stalled or lost
    const parked = task({ status: 'parked', wakeAt: now + 60_000 });
    const projector = new AgentTaskActivityProjector(new ActivityReader({}), () => now);
    expect(projector.project(job([parked], { status: 'parked' }), parked, 0).state).toBe('parked');
  });
});
