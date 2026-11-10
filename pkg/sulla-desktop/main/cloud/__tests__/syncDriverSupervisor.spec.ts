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
});
