// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const loggedIn = ref(false);
const vaultSetUp = ref(true);
const statusResolved = ref(false);
const unlockError = ref('');
const unlockMode = ref<'password' | 'recovery'>('password');
let statusGeneration = 0;

ipcRenderer.on('vault:logged-in' as any, () => {
  statusGeneration += 1;
  loggedIn.value = true;
  statusResolved.value = true;
  unlockError.value = '';
});
ipcRenderer.on('vault:logged-out' as any, () => {
  statusGeneration += 1;
  loggedIn.value = false;
  statusResolved.value = true;
});

type VaultStatus = { unlocked?: boolean; state?: string; setup?: { required?: boolean } };

function applyStatus(status: VaultStatus): void {
  loggedIn.value = status.unlocked === true;
  // A vault that doesn't exist yet has nothing to unlock: after first run it
  // is created from the Cloud account key in the background.
  vaultSetUp.value = status.state !== 'migration_required' && status.setup?.required !== true;
}

async function resolveStatus(generation: number): Promise<boolean> {
  try {
    const status = await ipcRenderer.invoke('vault:status' as any) as VaultStatus;
    if (generation !== statusGeneration) return loggedIn.value;
    applyStatus(status);
    statusResolved.value = true;
    return loggedIn.value;
  } catch {
    if (generation !== statusGeneration) return loggedIn.value;
    loggedIn.value = false;
    statusResolved.value = true;
    return false;
  }
}

async function refreshStatus(): Promise<boolean> {
  const generation = ++statusGeneration;

  return await resolveStatus(generation);
}

function invalidateStatus(): void {
  statusGeneration += 1;
  statusResolved.value = false;
}

async function tryAutoLogin(): Promise<void> {
  const generation = ++statusGeneration;

  statusResolved.value = false;
  // Ask first: a quick status call settles the common cases (already unlocked,
  // or no vault yet) without waiting on the Keychain bootstrap helper, which
  // kept the startup overlay up at 100% after first run.
  try {
    const status = await ipcRenderer.invoke('vault:status' as any) as VaultStatus;
    if (generation !== statusGeneration) return;
    if (status.unlocked === true || status.setup?.required === true || status.state === 'migration_required') {
      applyStatus(status);
      statusResolved.value = true;

      return;
    }
  } catch { /* vault still starting; fall through to the bootstrap path */ }
  try { await ipcRenderer.invoke('vault:initialize' as any) } catch { /* isolated bootstrap may be unavailable */ }
  await resolveStatus(generation);
}

/** Password/recovery entry is container-hosted; Desktop never accepts the secret. */
async function login(_password: string): Promise<boolean> { return await refreshStatus() }
async function loginWithRecoveryKey(_recoveryKey: string): Promise<boolean> { return await refreshStatus() }

async function logout(): Promise<void> {
  try { await ipcRenderer.invoke('vault:lock-vault' as any) } catch { /* state is still locked locally */ }
  loggedIn.value = false;
}

export function useVaultUnlock() {
  return { loggedIn, vaultSetUp, statusResolved, unlockError, unlockMode, tryAutoLogin, refreshStatus, invalidateStatus, login, loginWithRecoveryKey, logout };
}
