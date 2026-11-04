// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import {
  ContainerRetentionScheduler,
  type RetentionEnforcer, type RetentionSchedulerLogger, type RetentionSchedulerTimer,
} from '@pkg/agent/services/AgentContainerRetentionScheduler';
import type { RetentionReport } from '@pkg/agent/services/AgentContainerRetentionPolicy';

const emptyReport = (): RetentionReport => ({
  removed: [], errors: [], keptCount: 0, freeBytesBefore: null, freeBytesAfter: null,
});

class FakeSchedulerTimer implements RetentionSchedulerTimer {
  private sequence = 0;
  private readonly timers = new Map<number, { delayMs: number; callback: () => void }>();
  readonly armedDelays: number[] = [];

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = ++this.sequence;
    this.timers.set(id, { delayMs, callback });
    this.armedDelays.push(delayMs);
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void { this.timers.delete(timer as unknown as number) }

  /** Fires every timer currently armed, oldest first — mirrors one real tick. */
  fireAll(): void {
    const due = [...this.timers.entries()];
    for (const [id, entry] of due) { if (this.timers.delete(id)) entry.callback() }
  }
}

class FakeLogger implements RetentionSchedulerLogger {
  readonly infoLines: string[] = [];
  readonly errorLines: string[] = [];
  info(message: string): void { this.infoLines.push(message) }
  error(message: string): void { this.errorLines.push(message) }
}

/** Controls exactly when `enforce()` resolves, so tests can prove overlap can't happen. */
class ControlledEnforcer implements RetentionEnforcer {
  calls = 0;
  private pending: Array<(report: RetentionReport) => void> = [];

  enforce(): Promise<RetentionReport> {
    this.calls += 1;
    return new Promise(resolve => { this.pending.push(resolve) });
  }

  resolveOldest(report: RetentionReport = emptyReport()): void {
    const resolve = this.pending.shift();
    if (!resolve) throw new Error('no enforce() call pending to resolve');
    resolve(report);
  }

  get pendingCount(): number { return this.pending.length }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('ContainerRetentionScheduler', () => {
  it('runs once immediately on start(), then arms the next run intervalMs after the first settles', async() => {
    // risk: disk pressure from finished containers is never relieved because the scheduler never actually fires
    const enforcer = new ControlledEnforcer();
    const timer = new FakeSchedulerTimer();
    const scheduler = new ContainerRetentionScheduler(enforcer, timer, new FakeLogger(), 15 * 60_000);

    scheduler.start();
    expect(enforcer.calls).toBe(1);
    enforcer.resolveOldest();
    await settle();

    expect(timer.armedDelays).toEqual([15 * 60_000]);
  });

  it('never runs enforce() twice concurrently, even when runNow() is called while a scheduled run is in flight', async() => {
    // risk: an overlapping run double-counts removals or races the same container's remove() twice
    const enforcer = new ControlledEnforcer();
    const timer = new FakeSchedulerTimer();
    const scheduler = new ContainerRetentionScheduler(enforcer, timer, new FakeLogger(), 15 * 60_000);

    scheduler.start();
    expect(enforcer.calls).toBe(1);
    const manual = scheduler.runNow();
    await settle();
    expect(enforcer.calls).toBe(1); // runNow() joined the in-flight run instead of starting a second one

    enforcer.resolveOldest();
    await manual;
    expect(enforcer.calls).toBe(1);
  });

  it('stop() prevents the next scheduled run from arming', async() => {
    // risk: stop() during shutdown doesn't actually stop retention, so it keeps touching containers after the app meant to quiesce
    const enforcer = new ControlledEnforcer();
    const timer = new FakeSchedulerTimer();
    const scheduler = new ContainerRetentionScheduler(enforcer, timer, new FakeLogger(), 15 * 60_000);

    scheduler.start();
    scheduler.stop();
    enforcer.resolveOldest();
    await settle();

    expect(timer.armedDelays).toEqual([]);
  });

  it('logs enforce() failures instead of throwing, so one bad run does not kill the scheduler loop', async() => {
    // risk: an unhandled rejection from enforce() crashes the scheduler and retention silently stops forever
    const failing: RetentionEnforcer = { enforce: () => Promise.reject(new Error('guest exec unreachable')) };
    const timer = new FakeSchedulerTimer();
    const logger = new FakeLogger();
    const scheduler = new ContainerRetentionScheduler(failing, timer, logger, 15 * 60_000);

    scheduler.start();
    await settle();

    expect(logger.errorLines).toEqual(['[ContainerRetention] enforce failed: guest exec unreachable']);
    expect(timer.armedDelays).toEqual([15 * 60_000]);
  });
});
