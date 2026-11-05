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
  it('does nothing when a manager message already won the claim race', async() => {
    // risk: a manager message wakes now, then the old timer wakes the same thread again
    vi.useFakeTimers(); const wake = vi.fn(async() => undefined);
    const scheduler = new AgentWakeScheduler(new MemoryWaitRepository(null) as any, wake, () => 2);
    scheduler.schedule({ jobId: 'job-1', taskIndex: 0, wakeAt: new Date(1), reason: 'wait', state: 'scheduled' });
    await vi.runAllTimersAsync(); expect(wake).not.toHaveBeenCalled(); vi.useRealTimers();
  });
});
