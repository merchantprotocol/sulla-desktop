import { ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const loggedIn = ref(false);
const vaultSetUp = ref(true);
const unlockError = ref('');
const unlockMode = ref<'password' | 'recovery'>('password');

ipcRenderer.on('vault:logged-in' as any, () => { loggedIn.value = true; unlockError.value = '' });
ipcRenderer.on('vault:logged-out' as any, () => { loggedIn.value = false });

async function refreshStatus(): Promise<boolean> {
  try {
    const status = await ipcRenderer.invoke('vault:status') as { unlocked?: boolean; state?: string };
    loggedIn.value = status.unlocked === true;
    vaultSetUp.value = status.state !== 'migration_required';
    return loggedIn.value;
  } catch {
    loggedIn.value = false;
    return false;
  }
}

async function tryAutoLogin(): Promise<void> {
  try { await ipcRenderer.invoke('vault:initialize') } catch { /* isolated bootstrap may be unavailable */ }
  await refreshStatus();
}

/** Password/recovery entry is container-hosted; Desktop never accepts the secret. */
async function login(_password: string): Promise<boolean> { return await refreshStatus() }
async function loginWithRecoveryKey(_recoveryKey: string): Promise<boolean> { return await refreshStatus() }

async function logout(): Promise<void> {
  try { await ipcRenderer.invoke('vault:lock-vault') } catch { /* state is still locked locally */ }
  loggedIn.value = false;
}

export function useVaultUnlock() {
  return { loggedIn, vaultSetUp, unlockError, unlockMode, tryAutoLogin, refreshStatus, login, loginWithRecoveryKey, logout };
}
