import { ref } from 'vue';
import { getVaultKeyService } from '@pkg/agent/services/VaultKeyService';

// Shared reactive state — same instance across all components
const uiUnlocked = ref(false);
const vaultSetUp = ref(true);
const unlockError = ref('');
const unlockMode = ref<'password' | 'recovery'>('password');

/**
 * Try to auto-unlock on app start.
 * - If vault is not set up (first run): skip lock screen entirely
 * - If safeStorage has the VMK: auto-unlock, no prompt needed
 * - If safeStorage fails: keep locked, user must enter password
 */
async function tryAutoUnlock(): Promise<void> {
  try {
    const vault = getVaultKeyService();

    if (!vault.isSetUp()) {
      console.log('[useVaultUnlock] Vault not set up — skipping lock screen (first run)');
      vaultSetUp.value = false;
      uiUnlocked.value = true;
      return;
    }

    const success = await vault.initialize();
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
 * Re-derives VMK from password + stored salt.
 */
async function unlockWithPassword(password: string): Promise<boolean> {
  unlockError.value = '';

  try {
    const vault = getVaultKeyService();
    const success = await vault.recoverFromMasterPassword(password);

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
 * Decrypts the backup file and restores the VMK.
 */
async function unlockWithRecoveryKey(recoveryKey: string): Promise<boolean> {
  unlockError.value = '';

  try {
    const vault = getVaultKeyService();
    const success = await vault.recoverFromRecoveryKey(recoveryKey);

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

export function useVaultUnlock() {
  return {
    uiUnlocked,
    vaultSetUp,
    unlockError,
    unlockMode,
    tryAutoUnlock,
    unlockWithPassword,
    unlockWithRecoveryKey,
  };
}
