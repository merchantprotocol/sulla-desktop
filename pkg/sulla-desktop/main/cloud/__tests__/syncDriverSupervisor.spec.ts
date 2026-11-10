// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { SyncDriverSupervisor } from '../syncDriverSupervisor';

describe('SyncDriverSupervisor', () => {
  it('restarts an active driver that is stale, but never restarts a signed-out driver', () => {
    // risk: availability — recover a missed startup/retry without resurrecting signed-out sync.
    const restart=vi.fn();
    const supervisor=new SyncDriverSupervisor(()=>100_000);
    const staleDriver={running:true,startedAt:0,lastAttemptAt:50_000,intervalMs:10_000,restart};
    expect(supervisor.reconcile(staleDriver,true)).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(supervisor.reconcile(staleDriver,false)).toBe(false);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('trusts the driver schedule over attempt age, so quiet backoff is not restarted', () => {
    // risk: availability — a locked vault or not-ready Files backs off quietly; restarting it every minute defeats the backoff.
    const minute = 60_000;
    const now = 1_000_000_000;
    const restart = vi.fn();
    const supervisor = new SyncDriverSupervisor(() => now);
    const backingOff = {
      running: true, startedAt: now - 30 * minute, lastAttemptAt: now - 5 * minute,
      scheduledNextAt: now + 4 * minute, intervalMs: 15_000, restart,
    };
    expect(supervisor.reconcile(backingOff, true)).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts a running driver whose scheduled wake is overdue past the stall grace', () => {
    // risk: availability — a driver that stopped scheduling must come back on its own.
    const minute = 60_000;
    const now = 1_000_000_000;
    const restart = vi.fn();
    const supervisor = new SyncDriverSupervisor(() => now);
    const stalled = {
      running: true, startedAt: now - 30 * minute, lastAttemptAt: now - 5 * minute,
      scheduledNextAt: now - 3 * minute, intervalMs: 15_000, restart,
    };
    expect(supervisor.reconcile(stalled, true)).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('never restarts a signed-out driver even when its scheduled wake is overdue', () => {
    // risk: privacy — signed-out sync must stay off.
    const minute = 60_000;
    const now = 1_000_000_000;
    const restart = vi.fn();
    const supervisor = new SyncDriverSupervisor(() => now);
    const signedOut = {
      running: true, startedAt: now - 30 * minute, lastAttemptAt: now - 30 * minute,
      scheduledNextAt: now - 10 * minute, intervalMs: 15_000, restart,
    };
    expect(supervisor.reconcile(signedOut, false)).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });
});
