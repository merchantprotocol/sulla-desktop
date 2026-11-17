// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

/** The services the coordinator talks to; production wiring loads them lazily. */
export interface VaultStateDependencies {
  setUserLoggedIn(unlocked: boolean): Promise<void>;
  setLifecycleVaultUnlocked(unlocked: boolean): Promise<void>;
  initializeVaultKey(): Promise<boolean>;
  refreshMasterCache(): Promise<unknown>;
  vaultContainerUnlocked(): Promise<boolean>;
}

/** Production wiring: every dependency is imported at call time, exactly as sulla.ts did. */
export class DesktopVaultStateDependencies implements VaultStateDependencies {
  async setUserLoggedIn(unlocked: boolean): Promise<void> {
    const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
    setUserLoggedIn(unlocked);
  }

  async setLifecycleVaultUnlocked(unlocked: boolean): Promise<void> {
    const { getServiceLifecycleManager } = await import('@pkg/agent/services/ServiceLifecycleManager');
    await getServiceLifecycleManager().setVaultUnlocked(unlocked);
    const runtime = (await import('@pkg/main/cloud/orgFiles/OrgFilesDesktopRuntime')).OrgFilesDesktopRuntime.currentOrNull();
    if (unlocked) runtime?.onVaultUnlocked(); else runtime?.onVaultLocked();
  }

  async initializeVaultKey(): Promise<boolean> {
    const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
    return getVaultKeyService().initialize();
  }

  async refreshMasterCache(): Promise<unknown> {
    const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
    return getVaultKeyService().refreshMasterCache();
  }

  async vaultContainerUnlocked(): Promise<boolean> {
    const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
    const status = await getDesktopVaultClient().status();
    return status.unlocked;
  }
}

/**
 * Single owner of the vault unlock/lock state transitions.
 *
 * Boot refreshes the vault container in the background, which can replace the one the
 * lifecycle already unlocked. The lifecycle waits for the refreshed container, and any
 * later replacement re-runs the unlock so a fresh (locked) container never goes unnoticed.
 */
export class VaultStateCoordinator {
  private transition: Promise<void> = Promise.resolve();
  private containerReady: Promise<void> | null = null;
  private resolveContainerReady: (() => void) | null = null;
  private lifecycleInitialized = false;

  constructor(private readonly deps: VaultStateDependencies) {}

  /** Single event-bus entrypoint for every vault state transition (serialised). */
  publish(unlocked: boolean): Promise<void> {
    this.transition = this.transition.catch(() => undefined).then(async() => {
      await this.deps.setUserLoggedIn(unlocked);
      await this.deps.setLifecycleVaultUnlocked(unlocked);
    });
    return this.transition;
  }

  expectContainer(): void {
    if (this.resolveContainerReady) return;
    this.containerReady = new Promise<void>((resolve) => { this.resolveContainerReady = resolve });
  }

  markContainerReady(): void {
    this.resolveContainerReady?.();
    this.resolveContainerReady = null;
    if (!this.lifecycleInitialized) return;
    void (async() => {
      const unlocked = await this.deps.initializeVaultKey();
      console.log(`[Background] Vault container replaced; re-initialized: ${ unlocked ? 'unlocked' : 'locked' }`);
      await this.publish(unlocked);
    })().catch(error => console.warn('[Vault] Re-initialize after container replacement failed:', error));
  }

  async waitForContainer(timeoutMs = 90_000): Promise<void> {
    if (!this.containerReady) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.containerReady, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })]);
    if (timer) clearTimeout(timer);
  }

  /** The 'vault' lifecycle stage started (true) or stopped (false). */
  setLifecycleInitialized(initialized: boolean): void {
    this.lifecycleInitialized = initialized;
  }

  /** Refresh non-secret state only; migration and backup run inside the container. */
  async onVaultUnlocked(): Promise<void> {
    try {
      // Caching the key for auto-unlock is best-effort; it must never stop
      // the unlock from being published.
      try {
        await this.deps.refreshMasterCache();
      } catch (err) {
        console.warn('[Vault] Could not cache the vault key for auto-unlock:', (err as Error).message);
      }
      const unlocked = await this.deps.vaultContainerUnlocked();
      await this.publish(unlocked);
    } catch (err) {
      console.warn('[Vault] Container state is unavailable:', (err as Error).message);
      throw err;
    }
  }
}
