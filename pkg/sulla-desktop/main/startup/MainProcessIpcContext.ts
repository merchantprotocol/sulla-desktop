// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { VaultKeyService } from '@pkg/agent/services/VaultKeyService';
import type { BrowserTabViewManager } from '@pkg/window/browserTabViewManager';
import type { VaultViewManager } from '@pkg/window/vaultViewManager';

import type { VaultStateCoordinator } from './VaultStateCoordinator';
import type { VaultStatusMonitor } from './VaultStatusMonitor';

/** The `ipcMainProxy` background.ts hands to onMainProxyLoad. */
export interface IpcHandleRegistrar {
  handle(channel: string, listener: (...args: any[]) => any): void;
  on?(channel: string, listener: (...args: any[]) => void): void;
}

/** `@pkg/window`'s window lookup, injected so the import order stays in sulla.ts. */
export interface WindowLookup {
  getWindow(name: string): Electron.BrowserWindow | null;
}

/**
 * Shared state for one onMainProxyLoad run. Steps that resolve a service
 * (tab views, vault key, vault status) store it here for the steps after them.
 */
export class MainProcessIpcContext {
  tabViewManager?: BrowserTabViewManager;
  vaultKey?: VaultKeyService;
  vaultStatus?: VaultStatusMonitor;

  constructor(
    readonly ipc: IpcHandleRegistrar,
    readonly window: WindowLookup,
    readonly vaultViewManager: VaultViewManager,
    readonly vaultState: VaultStateCoordinator,
  ) {}

  tabs(): BrowserTabViewManager {
    if (!this.tabViewManager) throw new Error('Browser tab views are not registered yet');
    return this.tabViewManager;
  }

  vaultKeys(): VaultKeyService {
    if (!this.vaultKey) throw new Error('Vault key IPC is not registered yet');
    return this.vaultKey;
  }

  vaultStatusMonitor(): VaultStatusMonitor {
    if (!this.vaultStatus) throw new Error('Vault status IPC is not registered yet');
    return this.vaultStatus;
  }
}

/** One ordered step of onMainProxyLoad. */
export interface MainProcessIpcStep {
  readonly name: string;
  register(ctx: MainProcessIpcContext): Promise<void>;
}

/** Runs the onMainProxyLoad steps strictly in order; each awaits before the next. */
export class MainProcessIpcStartup {
  constructor(private readonly steps: readonly MainProcessIpcStep[]) {}

  async load(ctx: MainProcessIpcContext): Promise<void> {
    for (const step of this.steps) {
      await step.register(ctx);
    }
  }
}
