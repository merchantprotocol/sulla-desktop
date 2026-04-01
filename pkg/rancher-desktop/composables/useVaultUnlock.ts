import { ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// Shared reactive state — same instance across all components
const uiUnlocked = ref(false);
const vaultSetUp = ref(true);
const unlockError = ref('');
const unlockMode = ref<'password' | 'recovery'>('password');

/**
 * Try to auto-unlock on app start.
 * All vault key operations go through IPC to the main process
 * (safeStorage and fs are main-process only).
 */
async function tryAutoUnlock(): Promise<void> {
  try {
    const isSetUp = await ipcRenderer.invoke('vault:is-setup');

    if (!isSetUp) {
      console.log('[useVaultUnlock] Vault not set up — skipping lock screen (first run)');
      vaultSetUp.value = false;
      uiUnlocked.value = true;
      return;
    }

    const success = await ipcRenderer.invoke('vault:initialize');
    if (success) {
      console.log('[useVaultUnlock] Auto-unlocked via safeStorage');
      uiUnlocked.value = true;
    } else {
      console.log('[useVaultUnlock] safeStorage unavailable — showing lock screen');
      uiUnlocked.value = false;
    }
  } catch (err) {
    console.error('[useVaultUnlock] Auto-unlock failed:', err);
    uiUnlocked.value = false;
  }
}

/**
 * Unlock with the user's master password.
 */
async function unlockWithPassword(password: string): Promise<boolean> {
  unlockError.value = '';

  try {
    const success = await ipcRenderer.invoke('vault:unlock-password', { password });

    if (success) {
      uiUnlocked.value = true;
      return true;
    }

    unlockError.value = 'Incorrect password. Please try again.';
    return false;
  } catch (err) {
    unlockError.value = 'Unlock failed. Please try again.';
    console.error('[useVaultUnlock] Password unlock failed:', err);
    return false;
  }
}

/**
 * Unlock with a recovery key.
 */
async function unlockWithRecoveryKey(recoveryKey: string): Promise<boolean> {
  unlockError.value = '';

  try {
    const success = await ipcRenderer.invoke('vault:unlock-recovery', { recoveryKey });

    if (success) {
      uiUnlocked.value = true;
      return true;
    }

    unlockError.value = 'Invalid recovery key. Please check and try again.';
    return false;
  } catch (err) {
    unlockError.value = 'Recovery failed. Please try again.';
    console.error('[useVaultUnlock] Recovery key unlock failed:', err);
    return false;
  }
}

/**
 * Lock the vault UI and zero the VMK in memory.
 */
async function lockVault(): Promise<void> {
  try {
    await ipcRenderer.invoke('vault:lock');
  } catch { /* ok */ }
  uiUnlocked.value = false;
}

export function useVaultUnlock() {
  return {
    uiUnlocked,
    vaultSetUp,
    unlockError,
    unlockMode,
    tryAutoUnlock,
    unlockWithPassword,
    unlockWithRecoveryKey,
    lockVault,
  };
}
