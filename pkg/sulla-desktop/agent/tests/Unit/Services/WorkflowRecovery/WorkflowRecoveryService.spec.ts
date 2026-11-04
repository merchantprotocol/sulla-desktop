// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { WorkflowRecoveryService, type RecoveryClock } from '../../../../app/Services/WorkflowRecovery/WorkflowRecoveryService';

class FakeClock implements RecoveryClock {
  current = 1_000; callback?: () => void; cleared = 0; delay?: number;
  now(): number { return this.current; }
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> { this.callback = callback; this.delay = delay; return 7 as any; }
  clearTimeout(): void { this.cleared += 1; this.callback = undefined; }
  defer(callback: () => void): void { callback(); }
  tick(): void { const callback = this.callback; this.callback = undefined; callback?.(); }
}
class ExecutionFixture {
  stale: any[] = []; suspended: any[] = []; expiry: Date | null = null; recoveries = new Map<string, any>(); shutdowns = 0;
  async findStaleExecutions() { return this.stale; }
  async findSuspended() { return this.suspended; }
  async recover(id: string) { return this.recoveries.get(id) ?? null; }
  async suspendAllRunning() { this.shutdowns += 1; return []; }
  async nextLeaseExpiry() { return this.expiry; }
}
const row = (id: string) => ({ attributes: { execution_id: id, workflow_id: 'workflow', workflow_name: 'Review', started_at: 'now', auto_restart: false } });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('WorkflowRecoveryService', () => {
  it('uses the injected clock to recover an expired lease without a wall-clock wait', async() => {
    // risk: an interrupted workflow remains stranded until the app restarts again
    const store = new ExecutionFixture(); const clock = new FakeClock();
    store.expiry = new Date(clock.current + 2_000);
    const service = new WorkflowRecoveryService(store, { activate: vi.fn() }, clock, { notify: vi.fn() });
    await service.start();
    expect(clock.delay).toBe(2_250);
    store.stale = [row('stale')]; store.recoveries.set('stale', { execution: row('stale') }); store.expiry = null;
    clock.tick(); await settle();
    expect(service.takePending()).toEqual([expect.objectContaining({ executionId: 'stale' })]);
  });

  it('activates an auto-restart execution only once when both boot entry points run', async() => {
    // risk: duplicate boot recovery starts the same workflow execution twice
    const store = new ExecutionFixture();
    const automatic = row('automatic');
    automatic.attributes.auto_restart = true;
    store.suspended = [automatic];
    const activate = vi.fn(async() => undefined);
    const service = new WorkflowRecoveryService(store, { activate }, new FakeClock(), { notify: vi.fn() });

    await Promise.all([service.start(), service.recover()]);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'automatic' }));
  });

  it('activates the same execution again when it becomes stale after a successful restart', async() => {
    // risk: a workflow whose renewed lease expires is stranded until the app restarts
    const store = new ExecutionFixture();
    const automatic = row('automatic');
    automatic.attributes.auto_restart = true;
    store.suspended = [automatic];
    const activate = vi.fn(async() => undefined);
    const service = new WorkflowRecoveryService(store, { activate }, new FakeClock(), { notify: vi.fn() });

    await service.recover();
    await settle();
    store.suspended = [];
    store.stale = [automatic];
    store.recoveries.set('automatic', { execution: automatic });
    await service.recover();
    await settle();

    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('notifies the same suspended run only once across recovery passes', async() => {
    // risk: lease scans repeatedly interrupt the user for one paused run
    const store = new ExecutionFixture(); store.suspended = [row('manual')];
    const notify = vi.fn(async() => undefined);
    const service = new WorkflowRecoveryService(store, { activate: vi.fn() }, new FakeClock(), { notify });
    await service.recover(); await service.recover();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('clears its timer on stop and makes repeated stops harmless', async() => {
    // risk: recovery runs after database shutdown or shutdown side effects repeat
    const store = new ExecutionFixture(); const clock = new FakeClock(); store.expiry = new Date(5_000);
    const service = new WorkflowRecoveryService(store, { activate: vi.fn() }, clock, { notify: vi.fn() });
    await service.start(); await service.stop(); await service.stop();
    expect(clock.cleared).toBe(1);
    expect(store.shutdowns).toBe(1);
    expect(service.status()).toBe('stopped');
  });
});
