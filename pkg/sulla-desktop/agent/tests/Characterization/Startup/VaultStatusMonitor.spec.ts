// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of the vault status refresh and poll that used to be closure
// state inside onMainProxyLoad. risk: vault lock state (missed publish), and
// duplicate vault migrations or piled-up status calls against a slow vault.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/logging', () => ({ default: { sulla: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));

import { VaultMigrationRetry } from '../../../../main/startup/VaultMigrationRetry';
import { VaultStatusMonitor, type VaultStatusLike } from '../../../../main/startup/VaultStatusMonitor';

class FakeVaultClient {
  statusCalls = 0;
  migrateCalls = 0;
  readonly statuses: VaultStatusLike[] = [];
  migrationGate: Promise<void> = Promise.resolve();
  migrateError: Error | undefined;

  async status(): Promise<VaultStatusLike> {
    this.statusCalls++;
    return this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0];
  }

  async migrate(): Promise<unknown> {
    this.migrateCalls++;
    await this.migrationGate;
    if (this.migrateError) throw this.migrateError;
    return {};
  }
}

class Harness {
  readonly client = new FakeVaultClient();
  readonly published: boolean[] = [];
  lifecycleUnlocked = false;
  activeView = true;
  cacheRefreshed = true;
  cacheRefreshes = 0;

  monitor(retry?: VaultMigrationRetry): VaultStatusMonitor {
    return new VaultStatusMonitor({
      client:                 async() => this.client,
      lifecycleVaultUnlocked: () => this.lifecycleUnlocked,
      refreshMasterCache:     async() => { this.cacheRefreshes++; return this.cacheRefreshed },
      publish:                async(unlocked) => { this.published.push(unlocked) },
      hasActiveVaultView:     () => this.activeView,
    }, 1_000, retry);
  }
}

const unlocked = (extra: Partial<VaultStatusLike> = {}): VaultStatusLike => ({ unlocked: true, state: 'unlocked', ...extra });
const failed = (): VaultStatusLike => ({ unlocked: false, state: 'migration_failed' });
const locked = (extra: Partial<VaultStatusLike> = {}): VaultStatusLike => ({ unlocked: false, state: 'locked', ...extra });

afterEach(() => { vi.useRealTimers() });

describe('VaultStatusMonitor.refresh', () => {
  it('publishes only when the vault lock state differs from the lifecycle', async() => {
    const h = new Harness();
    h.client.statuses.push(unlocked());
    const monitor = h.monitor();

    await monitor.refresh();
    h.lifecycleUnlocked = true;
    await monitor.refresh();

    expect(h.published).toEqual([true]);
  });

  it('shares one in-flight refresh between concurrent callers', async() => {
    const h = new Harness();
    h.client.statuses.push(locked());
    const monitor = h.monitor();

    const [a, b] = await Promise.all([monitor.refresh(), monitor.refresh()]);

    expect(a).toBe(b);
    expect(h.client.statusCalls).toBe(1);
  });

  it('re-reads status after refreshing the cached key when the vault asks for it', async() => {
    const h = new Harness();
    h.client.statuses.push(locked({ cacheUpdateRequired: true }), unlocked());
    const monitor = h.monitor();

    const status = await monitor.refresh();

    expect(h.cacheRefreshes).toBe(1);
    expect(status.unlocked).toBe(true);
    expect(h.published).toEqual([true]);
  });

  it('keeps the first status when the key cache could not be refreshed', async() => {
    const h = new Harness();
    h.cacheRefreshed = false;
    h.client.statuses.push(locked({ cacheUpdateRequired: true }), unlocked());
    const monitor = h.monitor();

    const status = await monitor.refresh();

    expect(status.unlocked).toBe(false);
    expect(h.client.statusCalls).toBe(1);
  });

  it('runs a required migration, waits for it, then re-reads status', async() => {
    const h = new Harness();
    let release!: () => void;
    h.client.migrationGate = new Promise<void>((resolve) => { release = resolve });
    h.client.statuses.push(locked({ state: 'migration_required' }), unlocked());
    const monitor = h.monitor();

    const pending = monitor.refresh();
    const overlapping = monitor.refresh();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.published).toEqual([]);
    release();
    const [status] = await Promise.all([pending, overlapping]);

    expect(h.client.migrateCalls).toBe(1);
    expect(status.unlocked).toBe(true);
    expect(h.published).toEqual([true]);
  });

  it('starts a fresh refresh once the previous one settled', async() => {
    const h = new Harness();
    h.client.statuses.push(locked());
    const monitor = h.monitor();

    await monitor.refresh();
    await monitor.refresh();

    expect(h.client.statusCalls).toBe(2);
  });
});

// risk: data accuracy — a transient database error during the legacy migration must not strand the vault in migration_failed
describe('VaultStatusMonitor failed-migration retry', () => {
  it('retries a failed migration once its backoff is due, then re-reads status and publishes', async() => {
    const h = new Harness();
    let now = 0;
    h.client.statuses.push(failed(), failed(), unlocked());
    const monitor = h.monitor(new VaultMigrationRetry([5_000, 15_000, 45_000], () => now));

    await monitor.refresh();
    expect(h.client.migrateCalls).toBe(0); // not before the first delay

    now = 5_000;
    const status = await monitor.refresh();

    expect(h.client.migrateCalls).toBe(1);
    expect(status.unlocked).toBe(true);
    expect(h.published).toEqual([true]);
  });

  it('stops after three spaced attempts and never throws when every retry fails', async() => {
    const h = new Harness();
    let now = 0;
    h.client.statuses.push(failed());
    h.client.migrateError = new Error('connect ECONNREFUSED');
    const monitor = h.monitor(new VaultMigrationRetry([5_000, 15_000, 45_000], () => now));
    const callsAt = async(time: number) => { now = time; await monitor.refresh(); return h.client.migrateCalls };

    expect(await callsAt(0)).toBe(0);
    expect(await callsAt(5_000)).toBe(1);
    expect(await callsAt(5_000)).toBe(1); // a second refresh in the same instant does not retry again
    expect(await callsAt(19_999)).toBe(1);
    expect(await callsAt(20_000)).toBe(2);
    expect(await callsAt(64_999)).toBe(2);
    expect(await callsAt(65_000)).toBe(3);
    expect(await callsAt(10_000_000)).toBe(3); // budget spent for this process
  });

  it('retries while polling only after the first delay, not on every tick', async() => {
    vi.useFakeTimers();
    const h = new Harness();
    h.client.statuses.push(failed());
    h.client.migrateError = new Error('connect ETIMEDOUT');
    const monitor = h.monitor();

    monitor.startPolling();
    await vi.advanceTimersByTimeAsync(5_000); // first poll arms the backoff at t=1s; due at t=6s
    expect(h.client.migrateCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.client.migrateCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.client.migrateCalls).toBe(1);
    h.activeView = false;
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('does not retry a vault that is locked or unlocked', async() => {
    const h = new Harness();
    let now = 0;
    h.client.statuses.push(locked());
    const monitor = h.monitor(new VaultMigrationRetry([5_000], () => now));

    await monitor.refresh();
    now = 1_000_000;
    await monitor.refresh();

    expect(h.client.migrateCalls).toBe(0);
  });
});

describe('VaultStatusMonitor polling', () => {
  it('polls every second while the vault view is open and stops itself when it closes', async() => {
    vi.useFakeTimers();
    const h = new Harness();
    h.client.statuses.push(locked());
    const monitor = h.monitor();

    monitor.startPolling();
    monitor.startPolling();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.client.statusCalls).toBe(3);

    h.activeView = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.isPolling()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.client.statusCalls).toBe(3);
  });

  it('stops polling when the last vault view owner hides it', () => {
    vi.useFakeTimers();
    const h = new Harness();
    h.client.statuses.push(locked());
    const monitor = h.monitor();

    monitor.startPolling();
    monitor.viewHidden();
    expect(monitor.isPolling()).toBe(true);

    h.activeView = false;
    monitor.viewHidden();
    expect(monitor.isPolling()).toBe(false);
  });
});
