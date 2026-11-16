// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterization of the vault unlock/lock state machine that used to be
// module-level state in sulla.ts. risk: vault unlock (a missed or reordered
// publish leaves the UI or vault-gated services in the wrong lock state).

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/utils/logging', () => ({ default: { sulla: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));

import { VaultStateCoordinator, type VaultStateDependencies } from '../../../../main/startup/VaultStateCoordinator';

class FakeVaultDeps implements VaultStateDependencies {
  readonly events: string[] = [];
  initializeResult = true;
  containerUnlocked = true;
  refreshError: Error | undefined;
  statusError: Error | undefined;
  slowUnlockMenu = false;
  failNextMenu = false;

  async setUserLoggedIn(unlocked: boolean): Promise<void> {
    if (unlocked && this.slowUnlockMenu) await new Promise(resolve => setTimeout(resolve, 5));
    if (this.failNextMenu) { this.failNextMenu = false; throw new Error('menu unavailable') }
    this.events.push(`menu:${ unlocked }`);
  }

  async setLifecycleVaultUnlocked(unlocked: boolean): Promise<void> { this.events.push(`lifecycle:${ unlocked }`) }
  async initializeVaultKey(): Promise<boolean> { this.events.push('initialize'); return this.initializeResult }
  async refreshMasterCache(): Promise<unknown> {
    this.events.push('refreshMasterCache');
    if (this.refreshError) throw this.refreshError;
    return true;
  }

  async vaultContainerUnlocked(): Promise<boolean> {
    this.events.push('status');
    if (this.statusError) throw this.statusError;
    return this.containerUnlocked;
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => { vi.useRealTimers() });

describe('VaultStateCoordinator.publish', () => {
  it('updates the menu and then the lifecycle, one transition at a time in call order', async() => {
    const deps = new FakeVaultDeps();
    deps.slowUnlockMenu = true;
    const vault = new VaultStateCoordinator(deps);

    const first = vault.publish(true);
    const second = vault.publish(false);
    await Promise.all([first, second]);

    expect(deps.events).toEqual(['menu:true', 'lifecycle:true', 'menu:false', 'lifecycle:false']);
  });

  it('still applies the next transition after one fails', async() => {
    const deps = new FakeVaultDeps();
    deps.failNextMenu = true;
    const vault = new VaultStateCoordinator(deps);

    await expect(vault.publish(true)).rejects.toThrow('menu unavailable');
    await vault.publish(false);

    expect(deps.events).toEqual(['menu:false', 'lifecycle:false']);
  });
});

describe('VaultStateCoordinator container replacement', () => {
  it('does not re-initialize the vault before the vault lifecycle stage has started', async() => {
    const deps = new FakeVaultDeps();
    const vault = new VaultStateCoordinator(deps);

    vault.expectContainer();
    vault.markContainerReady();
    await flush();

    expect(deps.events).toEqual([]);
  });

  it('re-initializes and publishes the real state when the container is replaced after startup', async() => {
    const deps = new FakeVaultDeps();
    deps.initializeResult = false;
    const vault = new VaultStateCoordinator(deps);

    vault.setLifecycleInitialized(true);
    vault.markContainerReady();
    await flush();

    expect(deps.events).toEqual(['initialize', 'menu:false', 'lifecycle:false']);
  });

  it('stops re-initializing once the vault stage is stopped', async() => {
    const deps = new FakeVaultDeps();
    const vault = new VaultStateCoordinator(deps);

    vault.setLifecycleInitialized(true);
    vault.setLifecycleInitialized(false);
    vault.markContainerReady();
    await flush();

    expect(deps.events).toEqual([]);
  });

  it('waits for an expected container and returns as soon as it is ready', async() => {
    const vault = new VaultStateCoordinator(new FakeVaultDeps());
    let done = false;

    vault.expectContainer();
    const waiting = vault.waitForContainer(60_000).then(() => { done = true });
    await flush();
    expect(done).toBe(false);

    vault.markContainerReady();
    await waiting;
    expect(done).toBe(true);
  });

  it('gives up waiting after the timeout so a stuck container cannot block startup', async() => {
    vi.useFakeTimers();
    const vault = new VaultStateCoordinator(new FakeVaultDeps());
    let done = false;

    vault.expectContainer();
    const waiting = vault.waitForContainer(90_000).then(() => { done = true });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
  });

  it('does not wait at all when no container refresh was announced', async() => {
    vi.useFakeTimers();
    const vault = new VaultStateCoordinator(new FakeVaultDeps());

    await expect(vault.waitForContainer()).resolves.toBeUndefined();
  });

  it('keeps one pending wait when the container is announced twice', async() => {
    const vault = new VaultStateCoordinator(new FakeVaultDeps());

    vault.expectContainer();
    const waiting = vault.waitForContainer(60_000);
    vault.expectContainer();
    vault.markContainerReady();

    await expect(waiting).resolves.toBeUndefined();
  });
});

describe('VaultStateCoordinator.onVaultUnlocked', () => {
  it('caches the key, reads the container state and publishes it', async() => {
    const deps = new FakeVaultDeps();
    const vault = new VaultStateCoordinator(deps);

    await vault.onVaultUnlocked();

    expect(deps.events).toEqual(['refreshMasterCache', 'status', 'menu:true', 'lifecycle:true']);
  });

  it('still publishes the unlock when caching the key for auto-unlock fails', async() => {
    const deps = new FakeVaultDeps();
    deps.refreshError = new Error('keychain denied');
    const vault = new VaultStateCoordinator(deps);

    await vault.onVaultUnlocked();

    expect(deps.events).toEqual(['refreshMasterCache', 'status', 'menu:true', 'lifecycle:true']);
  });

  it('rethrows and publishes nothing when the container state is unavailable', async() => {
    const deps = new FakeVaultDeps();
    deps.statusError = new Error('vault container down');
    const vault = new VaultStateCoordinator(deps);

    await expect(vault.onVaultUnlocked()).rejects.toThrow('vault container down');
    expect(deps.events).toEqual(['refreshMasterCache', 'status']);
  });
});
