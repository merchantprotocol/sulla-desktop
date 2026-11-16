// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of the vault status refresh and poll that used to be closure
// state inside onMainProxyLoad. risk: vault lock state (missed publish), and
// duplicate vault migrations or piled-up status calls against a slow vault.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/logging', () => ({ default: { sulla: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));

import { VaultStatusMonitor, type VaultStatusLike } from '../../../../main/startup/VaultStatusMonitor';

class FakeVaultClient {
  statusCalls = 0;
  migrateCalls = 0;
  readonly statuses: VaultStatusLike[] = [];
  migrationGate: Promise<void> = Promise.resolve();

  async status(): Promise<VaultStatusLike> {
    this.statusCalls++;
    return this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0];
  }

  async migrate(): Promise<unknown> {
    this.migrateCalls++;
    await this.migrationGate;
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

  monitor(): VaultStatusMonitor {
    return new VaultStatusMonitor({
      client:                 async() => this.client,
      lifecycleVaultUnlocked: () => this.lifecycleUnlocked,
      refreshMasterCache:     async() => { this.cacheRefreshes++; return this.cacheRefreshed },
      publish:                async(unlocked) => { this.published.push(unlocked) },
      hasActiveVaultView:     () => this.activeView,
    });
  }
}

const unlocked = (extra: Partial<VaultStatusLike> = {}): VaultStatusLike => ({ unlocked: true, state: 'unlocked', ...extra });
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
