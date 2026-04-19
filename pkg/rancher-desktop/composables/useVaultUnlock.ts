import { ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// Shared reactive state — same instance across all components
const loggedIn = ref(false);
const vaultSetUp = ref(true);
const unlockError = ref('');
const unlockMode = ref<'password' | 'recovery'>('password');

// Listen for cross-window auth broadcasts from main process
ipcRenderer.on('vault:logged-in' as any, () => {
  loggedIn.value = true;
  unlockError.value = '';
});
ipcRenderer.on('vault:logged-out' as any, () => {
  loggedIn.value = false;
});

/**
 * Check login state on app start.
 * The vault auto-unlocks from safeStorage (agent can work immediately).
 * But the UI always requires the user to enter their password to log in.
 */
async function tryAutoLogin(): Promise<void> {
  try {
    const isSetUp = await ipcRenderer.invoke('vault:is-setup');

    if (!isSetUp) {
      console.log('[useVaultUnlock] Vault not set up — skipping login screen (first run)');
      vaultSetUp.value = false;
      loggedIn.value = true;
      return;
    }

    // Auto-unlock the vault so the agent can work in the background
    await ipcRenderer.invoke('vault:initialize');

    // If we can't verify passwords (no canary yet), skip the login screen
    const canVerify = await ipcRenderer.invoke('vault:can-verify');
    if (!canVerify) {
      console.log('[useVaultUnlock] No password verification available — auto-login');
      loggedIn.value = true;
      return;
    }

    // UI always starts locked — user must enter password
    console.log('[useVaultUnlock] Login screen required');
    loggedIn.value = false;
  } catch (err) {
    console.error('[useVaultUnlock] Login check failed:', err);
    loggedIn.value = false;
  }
}

/**
 * Log in with master password.
 */
async function login(password: string): Promise<boolean> {
  unlockError.value = '';

  try {
    const success = await ipcRenderer.invoke('vault:unlock-password', { password });

    if (success) {
      loggedIn.value = true;
      return true;
    }

    unlockError.value = 'Incorrect password. Please try again.';
    return false;
  } catch (err) {
    unlockError.value = 'Login failed. Please try again.';
    console.error('[useVaultUnlock] Login failed:', err);
    return false;
  }
}

/**
 * Log in with recovery key.
 */
async function loginWithRecoveryKey(recoveryKey: string): Promise<boolean> {
  unlockError.value = '';

  try {
    const success = await ipcRenderer.invoke('vault:unlock-recovery', { recoveryKey });

    if (success) {
      loggedIn.value = true;
      return true;
    }

    unlockError.value = 'Invalid recovery key. Please check and try again.';
    return false;
  } catch (err) {
    unlockError.value = 'Recovery failed. Please try again.';
    console.error('[useVaultUnlock] Recovery login failed:', err);
    return false;
  }
}

/**
 * Log out — UI gate only. The vault key stays in memory so the agent can keep working.
 */
async function logout(): Promise<void> {
  try {
    await ipcRenderer.invoke('vault:logout');
  } catch { /* ok */ }
  loggedIn.value = false;
}

export function useVaultUnlock() {
  return {
    loggedIn,
    vaultSetUp,
    unlockError,
    unlockMode,
    tryAutoLogin,
    login,
    loginWithRecoveryKey,
    logout,
  };
}
