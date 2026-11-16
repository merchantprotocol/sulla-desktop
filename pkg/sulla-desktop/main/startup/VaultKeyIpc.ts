// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';

import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';
import { VaultIpcInputPolicy } from './VaultIpcInputPolicy';

/** Vault setup/unlock/lock, backups, v2 item access, the closed sync crypto channels and lifecycle status. */
export class VaultKeyIpc implements MainProcessIpcStep {
  readonly name = 'vault-key';

  async register(ctx: MainProcessIpcContext): Promise<void> {
    const { ipc } = ctx;
    const tabViewManager = ctx.tabs();
    const vaultKey = ctx.vaultKeys();
    const policy = new VaultIpcInputPolicy(ctx.window);

    ipc.handle('vault:is-setup', async() => {
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      const client = getDesktopVaultClient();
      await client.status();
      // Unknown service metadata must lead to the pre-unlock/setup container UI,
      // never a Desktop-side setup form or a false "already configured" state.
      return client.isSetUp() ?? false;
    });

    ipc.handle('vault:can-verify', async() => {
      return vaultKey.canVerifyPassword();
    });

    ipc.handle('vault:is-unlocked', async() => {
      return vaultKey.isUnlocked();
    });

    ipc.handle('vault:initialize', async() => {
      const unlocked = await vaultKey.initialize();
      if (unlocked) await ctx.vaultState.onVaultUnlocked();
      return unlocked;
    });

    ipc.handle('vault:setup', async(_event: Electron.IpcMainInvokeEvent, data: { masterPassword: string }) => {
      policy.denyLegacyVaultIpc();
      // Throws VAULT_ALREADY_SET_UP rather than orphaning an existing vault.
      const result = await vaultKey.setupFromMasterPassword(data.masterPassword);
      const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
      setUserLoggedIn(true);
      await ctx.vaultState.onVaultUnlocked();
      return { recoveryKey: result.recoveryKey };
    });

    ipc.handle('vault:change-password', async(_event: Electron.IpcMainInvokeEvent, data: { currentPassword: string; newPassword: string }) => {
      policy.denyLegacyVaultIpc();
      // Re-wraps the vault key only: stored credentials, the recovery key and
      // existing backups all stay valid. Throws VAULT_WRONG_PASSWORD.
      await vaultKey.changePassword(data?.currentPassword, data?.newPassword);
      const { getVaultBackupService } = await import('@pkg/agent/services/VaultBackupService');
      await getVaultBackupService().snapshotSafely('password-change');
      return { success: true };
    });

    ipc.handle('vault:unlock-password', async(_event: Electron.IpcMainInvokeEvent, data: { password: string }) => {
      policy.denyLegacyVaultIpc();
      const success = await vaultKey.recoverFromMasterPassword(data.password);
      if (success) {
        const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
        setUserLoggedIn(true);
        await ctx.vaultState.onVaultUnlocked();
      }
      return success;
    });

    ipc.handle('vault:unlock-recovery', async(_event: Electron.IpcMainInvokeEvent, data: { recoveryKey: string }) => {
      policy.denyLegacyVaultIpc();
      const success = await vaultKey.recoverFromRecoveryKey(data.recoveryKey);
      if (success) {
        const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
        setUserLoggedIn(true);
        await ctx.vaultState.onVaultUnlocked();
      }
      return success;
    });

    ipc.handle('vault:backup-status', async() => {
      const { getVaultBackupService } = await import('@pkg/agent/services/VaultBackupService');
      const backups = getVaultBackupService();

      return { dir: backups.backupDir, snapshots: backups.listSnapshots() };
    });

    ipc.handle('vault:backup-now', async() => {
      policy.denyLegacyVaultIpc();
      const { getVaultBackupService } = await import('@pkg/agent/services/VaultBackupService');

      try {
        const file = await getVaultBackupService().createSnapshot('manual', { force: true });

        return { success: !!file, path: file };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipc.handle('vault:logout', async() => {
      // UI logout only — do NOT zero the VMK so the agent can keep working
      const { setUserLoggedIn } = await import('@pkg/main/mainmenu');
      setUserLoggedIn(false);
      // Clear focus so every native browser tab detaches and the login
      // screen is the topmost thing in the window.
      tabViewManager.setFocusedTab(null);
      return true;
    });

    ipc.handle('vault:lock-vault', async() => {
      const { getSullaFilesWatcher } = await import('@pkg/main/sullaFilesWatcher');
      const filesLock = getSullaFilesWatcher().lockService();
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      // Mark local state locked immediately, but do not report success until the
      // container confirms it zeroed keys and revoked every session.
      await getDesktopVaultClient().lock();
      await ctx.vaultState.publish(false);
      // Clear focus so every native browser tab detaches and the login
      // screen is the topmost thing in the window.
      tabViewManager.setFocusedTab(null);
      await filesLock;
      return true;
    });

    ipc.handle('vault:v2-is-unlocked', async() => {
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      return getDesktopVaultClient().ensureUnlocked();
    });
    ipc.handle('vault:v2-list', async() => {
      policy.denyLegacyVaultIpc();
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      return getDesktopVaultClient().list();
    });
    ipc.handle('vault:v2-get', async(_event: Electron.IpcMainInvokeEvent, id: string) => {
      policy.denyLegacyVaultIpc();
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      return getDesktopVaultClient().get(id);
    });
    ipc.handle('vault:v2-save', async(_event: Electron.IpcMainInvokeEvent, data: { id?: string; revision?: number; plaintext: unknown }) => {
      policy.denyLegacyVaultIpc();
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      return getDesktopVaultClient().save(data.id, data.plaintext as any, data.revision);
    });
    ipc.handle('vault:v2-delete', async(_event: Electron.IpcMainInvokeEvent, data: { id: string; revision: number }) => {
      policy.denyLegacyVaultIpc();
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      await getDesktopVaultClient().remove(data.id, data.revision);
      return true;
    });
    ipc.handle('vault:v2-audit', async(_event: Electron.IpcMainInvokeEvent, itemId?: string) => {
      policy.denyLegacyVaultIpc();
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      return getDesktopVaultClient().auditFor(itemId);
    });

    ipc.handle('vault:read-account', async(_event: Electron.IpcMainInvokeEvent, data: { integrationId: string; accountId: string }) => {
      policy.denyLegacyVaultIpc();
      try {
        const result = await getIntegrationService().getSerializableFormValues(data.integrationId, data.accountId);
        return result;
      } catch {
        return {
          success: false,
          error: {
            code:    'VAULT_DECRYPT_FAILED',
            message: 'Unable to read vault credential.',
          },
        };
      }
    });

    // Sync decrypt/encrypt for renderer-side IntegrationValueModel
    const { ipcMain } = await import('electron');
    ipcMain.on('vault:decrypt-sync', (event, encrypted: unknown) => {
      event.returnValue = '';
      return;
      try {
        if (typeof encrypted !== 'string') {
          event.returnValue = '';
          return;
        }
        if (vaultKey.isUnlocked() && vaultKey.isEncrypted(encrypted)) {
          event.returnValue = vaultKey.decrypt(encrypted);
        } else {
          event.returnValue = encrypted;
        }
      } catch {
        // Return only a primitive sentinel. Returning the malformed input can
        // cross Electron's sync IPC boundary as a host object and terminate V8.
        event.returnValue = '';
      }
    });

    ipcMain.on('vault:encrypt-sync', (event, plaintext: unknown) => {
      event.returnValue = '';
      return;
      // '' means "refused": the renderer model throws instead of persisting
      // plaintext. Only a never-configured vault stores values as-is.
      try {
        if (typeof plaintext !== 'string') {
          event.returnValue = '';
        } else if (vaultKey.isEncrypted(plaintext)) {
          event.returnValue = plaintext;
        } else if (vaultKey.isUnlocked()) {
          event.returnValue = vaultKey.encrypt(plaintext);
        } else if (vaultKey.isSetUp()) {
          event.returnValue = '';
        } else {
          event.returnValue = plaintext;
        }
      } catch {
        event.returnValue = '';
      }
    });

    // ── Lifecycle: expose startup/shutdown phase to renderer ──
    ipcMain.on('lifecycle:status', (event) => {
      const lm = getServiceLifecycleManager();

      event.returnValue = {
        ready:        lm.isStartupComplete(),
        shuttingDown: lm.isShuttingDown(),
      };
    });
  }
}
