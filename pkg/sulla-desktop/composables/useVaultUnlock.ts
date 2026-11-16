// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type VaultStatus = { unlocked?: boolean; state?: string; setup?: { required?: boolean } };

/** The IPC surface the unlock state needs. Injected so the state machine runs without Electron. */
export interface VaultUnlockIpc {
  on(channel: string, listener: () => void): unknown;
  invoke(channel: string): Promise<unknown>;
}

/**
 * Shared vault unlock state for the renderer. One controller owns the refs and the status generation,
 * so overlapping status calls can never apply a stale answer.
 */
export class VaultUnlockController {
  readonly loggedIn = ref(false);
  readonly vaultSetUp = ref(true);
  readonly statusResolved = ref(false);
  readonly unlockError = ref('');
  readonly unlockMode = ref<'password' | 'recovery'>('password');
  private statusGeneration = 0;

  constructor(private readonly ipc: VaultUnlockIpc = ipcRenderer as unknown as VaultUnlockIpc) {
    this.ipc.on('vault:logged-in', () => {
      this.statusGeneration += 1;
      this.loggedIn.value = true;
      this.vaultSetUp.value = true;
      this.statusResolved.value = true;
      this.unlockError.value = '';
    });
    this.ipc.on('vault:logged-out', () => {
      this.statusGeneration += 1;
      this.loggedIn.value = false;
      this.statusResolved.value = true;
      void this.refreshStatus();
    });
  }

  async tryAutoLogin(): Promise<void> {
    const generation = ++this.statusGeneration;

    this.statusResolved.value = false;
    // Ask first: a quick status call settles the common cases (already unlocked,
    // or no vault yet) without waiting on the Keychain bootstrap helper, which
    // kept the startup overlay up at 100% after first run.
    try {
      const status = await this.ipc.invoke('vault:status') as VaultStatus;
      if (generation !== this.statusGeneration) return;
      if (status.unlocked === true || status.setup?.required === true || status.state === 'migration_required') {
        this.applyStatus(status);
        this.statusResolved.value = true;

        return;
      }
    } catch { /* vault still starting; fall through to the bootstrap path */ }
    try { await this.ipc.invoke('vault:initialize') } catch (error) {
      this.unlockError.value = error instanceof Error ? error.message : 'The vault could not be unlocked.';
    }
    await this.resolveStatus(generation);
  }

  refreshStatus(): Promise<boolean> {
    const generation = ++this.statusGeneration;

    return this.resolveStatus(generation);
  }

  invalidateStatus(): void {
    this.statusGeneration += 1;
    this.statusResolved.value = false;
  }

  /** Password/recovery entry is container-hosted; Desktop never accepts the secret. */
  login(_password: string): Promise<boolean> { return this.refreshStatus() }
  loginWithRecoveryKey(_recoveryKey: string): Promise<boolean> { return this.refreshStatus() }

  async logout(): Promise<void> {
    try { await this.ipc.invoke('vault:lock-vault') } catch { /* state is still locked locally */ }
    this.loggedIn.value = false;
  }

  /** The public surface, with methods bound so callers can destructure them. */
  surface() {
    return {
      loggedIn: this.loggedIn,
      vaultSetUp: this.vaultSetUp,
      statusResolved: this.statusResolved,
      unlockError: this.unlockError,
      unlockMode: this.unlockMode,
      tryAutoLogin: () => this.tryAutoLogin(),
      refreshStatus: () => this.refreshStatus(),
      invalidateStatus: () => this.invalidateStatus(),
      login: (password: string) => this.login(password),
      loginWithRecoveryKey: (recoveryKey: string) => this.loginWithRecoveryKey(recoveryKey),
      logout: () => this.logout(),
    };
  }

  private applyStatus(status: VaultStatus): void {
    this.loggedIn.value = status.unlocked === true;
    // A vault that doesn't exist yet has nothing to unlock: after first run it
    // is created from the Cloud account key in the background.
    this.vaultSetUp.value = status.state !== 'migration_required' && status.setup?.required !== true;
  }

  private async resolveStatus(generation: number): Promise<boolean> {
    try {
      const status = await this.ipc.invoke('vault:status') as VaultStatus;
      if (generation !== this.statusGeneration) return this.loggedIn.value;
      this.applyStatus(status);
      this.statusResolved.value = true;
      return this.loggedIn.value;
    } catch (error) {
      if (generation !== this.statusGeneration) return this.loggedIn.value;
      this.loggedIn.value = false;
      this.unlockError.value = error instanceof Error ? error.message : 'The vault is unavailable.';
      this.statusResolved.value = true;
      return false;
    }
  }
}

/** The renderer-wide controller. Created once when this module loads, as before. */
export const vaultUnlock = new VaultUnlockController();

export function useVaultUnlock() {
  return vaultUnlock.surface();
}
