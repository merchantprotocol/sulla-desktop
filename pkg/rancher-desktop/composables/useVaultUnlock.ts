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

async function resolveStatus(generation: number): Promise<boolean> {
  try {
    const status = await ipcRenderer.invoke('vault:status' as any) as { unlocked?: boolean; state?: string };
    if (generation !== statusGeneration) return loggedIn.value;
    loggedIn.value = status.unlocked === true;
    vaultSetUp.value = status.state !== 'migration_required';
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
