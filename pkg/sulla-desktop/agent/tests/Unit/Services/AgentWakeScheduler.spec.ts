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
/** Mirrors the real claim/release state machine: a claimed row stays claimed until released. */
class ClaimingWaitRepository {
  constructor(public row: AgentTaskWait) {}
  scheduled() { return Promise.resolve(this.row.state === 'scheduled' ? [this.row] : []) }
  claim() {
    if (this.row.state !== 'scheduled') return Promise.resolve(null);
    this.row = { ...this.row, state: 'claimed' };
    return Promise.resolve(this.row);
  }

  release(_jobId: string, _taskIndex: number, wakeAt: Date) {
    if (this.row.state !== 'claimed') return Promise.resolve(null);
    this.row = { ...this.row, state: 'scheduled', wakeAt };
    return Promise.resolve(this.row);
  }
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

  it('releases and retries a claimed wake whose delivery throws instead of stranding it claimed', async() => {
    // risk: wakeParkedAgent threw ("is not a parked agent job", 2026-11-14 17:26) after the
    // claim; the wait stayed claimed, nothing retried it and restarts skip claimed rows
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let now = 2;
    const repository = new ClaimingWaitRepository({ jobId: 'job-1', taskIndex: 0, wakeAt: new Date(1), reason: 'deploy', state: 'scheduled' });
    const wake = vi.fn(() => Promise.resolve()).mockRejectedValueOnce(new Error('Thread t is not a parked agent job.'));
    const scheduler = new AgentWakeScheduler(repository as any, wake, () => now);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(repository.row.state).toBe('scheduled');
    now += AgentWakeScheduler.RETRY_DELAY_MS;
    await vi.advanceTimersByTimeAsync(AgentWakeScheduler.RETRY_DELAY_MS);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(repository.row.state).toBe('claimed');
    vi.restoreAllMocks(); vi.useRealTimers();
  });

  it('retries a wake that was deferred because the thread had a turn in flight', async() => {
    // risk: wakeParkedAgent returned false (turn already running) and the timer wake was simply lost
    vi.useFakeTimers();
    let now = 2;
    const repository = new ClaimingWaitRepository({ jobId: 'job-1', taskIndex: 0, wakeAt: new Date(1), reason: 'deploy', state: 'scheduled' });
    const wake = vi.fn(() => Promise.resolve(true)).mockResolvedValueOnce(false);
    const scheduler = new AgentWakeScheduler(repository as any, wake, () => now);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    now += AgentWakeScheduler.RETRY_DELAY_MS;
    await vi.advanceTimersByTimeAsync(AgentWakeScheduler.RETRY_DELAY_MS);
    expect(wake).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    expect(wake).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('stops retrying after the attempt cap but leaves the wait scheduled for the next app start', async() => {
    // risk: an undeliverable wake either loops forever in-process or is lost for good
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let now = 2;
    const repository = new ClaimingWaitRepository({ jobId: 'job-1', taskIndex: 0, wakeAt: new Date(1), reason: 'deploy', state: 'scheduled' });
    const wake = vi.fn(() => Promise.resolve(false));
    const scheduler = new AgentWakeScheduler(repository as any, wake, () => now);
    await scheduler.start();
    for (let step = 0; step < 20; step++) {
      now += 10 * AgentWakeScheduler.RETRY_DELAY_MS;
      await vi.advanceTimersByTimeAsync(10 * AgentWakeScheduler.RETRY_DELAY_MS);
    }
    expect(wake).toHaveBeenCalledTimes(AgentWakeScheduler.MAX_ATTEMPTS);
    expect(repository.row.state).toBe('scheduled');
    expect(await repository.scheduled()).toHaveLength(1);
    vi.restoreAllMocks(); vi.useRealTimers();
  });
});
