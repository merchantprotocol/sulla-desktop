// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AgentWakeScheduler } from '../../../services/AgentWakeScheduler';
import type { AgentTaskWait } from '../../../app/Repositories/AgentTaskWaitRepository';
class MemoryWaitRepository {
  constructor(private wait: AgentTaskWait | null) {}
  async scheduled() { return this.wait ? [this.wait] : []; }
  async claim() { const claimed = this.wait; this.wait = null; return claimed; }
  async cancel() { const cancelled = Boolean(this.wait); this.wait = null; return cancelled; }
}
describe('AgentWakeScheduler', () => {
  it('rehydrates a due wait at startup and wakes it exactly once', async() => {
    // risk: app restart strands a parked worker or resumes its thread twice
    vi.useFakeTimers();
    const wait: AgentTaskWait = { jobId: 'job-1', taskIndex: 0, wakeAt: new Date(1), reason: 'external work', state: 'scheduled' };
    const wake = vi.fn(async() => undefined);
    const scheduler = new AgentWakeScheduler(new MemoryWaitRepository(wait) as any, wake, () => 2);
    await scheduler.start(); await vi.runAllTimersAsync(); await vi.runAllTimersAsync();
    expect(wake).toHaveBeenCalledTimes(1); vi.useRealTimers();
  });
  it('does nothing when a manager message cancels the durable wait before the old timer fires', async() => {
    // risk: a manager message wakes now, then the old timer wakes the same thread again
    vi.useFakeTimers();
    const wake = vi.fn(async() => undefined);
    const wait: AgentTaskWait = { jobId: 'job-1', taskIndex: 0, wakeAt: new Date(1_000), reason: 'wait', state: 'scheduled' };
    const repository = new MemoryWaitRepository(wait);
    const scheduler = new AgentWakeScheduler(repository as any, wake, () => 2);
    scheduler.schedule(wait);
    expect(await repository.cancel()).toBe(true);
    scheduler.cancel('job-1', 0);
    await vi.runAllTimersAsync();
    expect(await repository.claim()).toBeNull();
    expect(wake).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
