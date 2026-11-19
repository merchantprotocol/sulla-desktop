// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Logging from '@pkg/utils/logging';

import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';
import { VaultIpcInputPolicy } from './VaultIpcInputPolicy';
import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';

const console = Logging.sulla;

/** Vault export, website credential save and autofill (legacy channels stay closed by policy). */
export class VaultTransferIpc implements MainProcessIpcStep {
  readonly name = 'vault-transfer';

  async register(ctx: MainProcessIpcContext): Promise<void> {
    const { ipc, window } = ctx;
    const tabViewManager = ctx.tabs();
    const vaultKey = ctx.vaultKeys();
    const policy = new VaultIpcInputPolicy(window);

    // ── Vault: export & import ─────────────────────────────────────────────────
    const { dialog } = await import('electron');
    const fsPromises = await import('fs/promises');

    ipc.handle('vault:export', async(event: Electron.IpcMainInvokeEvent, data: { encrypted: boolean }) => {
      policy.denyLegacyVaultIpc();
      try {
        const { getIntegrationService: getIS } = await import('@pkg/agent/services/IntegrationService');
        const service = getIS();
        await service.initialize();

        const enabled = await service.getEnabledIntegrations();
        const exportData: any[] = [];

        for (const { integrationId, accounts } of enabled) {
          for (const acct of accounts) {
            const formValues = await service.getFormValues(integrationId, acct.account_id);
            const values: Record<string, string> = {};
            for (const fv of formValues) {
              values[fv.property] = fv.value;
            }
            exportData.push({
              integrationId,
              accountId:  acct.account_id,
              label:      acct.label,
              connected:  acct.connected,
              active:     acct.active,
              values,
            });
          }
        }

        let content: string;
        let defaultName: string;

        if (data.encrypted) {
          const vault = vaultKey;
          if (!vault.isUnlocked()) {
            return { success: false, error: 'Vault is locked' };
          }
          // Self-contained: restorable on any machine with the master password
          // or recovery key, and still valid after a password change.
          const { getVaultBackupService } = await import('@pkg/agent/services/VaultBackupService');
          content = await getVaultBackupService().buildExport();
          defaultName = `sulla-vault-backup-${ new Date().toISOString().slice(0, 10) }.enc`;
        } else {
          content = JSON.stringify(exportData, null, 2);
          defaultName = `sulla-vault-export-${ new Date().toISOString().slice(0, 10) }.json`;
        }

        const senderWindow = agentWindowFromSender(event.sender);
        const result = await dialog.showSaveDialog(senderWindow!, {
          title:       data.encrypted ? 'Export Encrypted Vault Backup' : 'Export Vault (Plain Text)',
          defaultPath: defaultName,
          filters:     data.encrypted
            ? [{ name: 'Encrypted Backup', extensions: ['enc'] }]
            : [{ name: 'JSON', extensions: ['json'] }],
        });

        if (result.canceled || !result.filePath) {
          return { success: false, canceled: true };
        }

        await fsPromises.writeFile(result.filePath, content, { encoding: 'utf-8', mode: 0o600 });
        console.log(`[Vault] Exported ${ exportData.length } accounts to ${ result.filePath }`);
        return { success: true, count: exportData.length, path: result.filePath };
      } catch (err: any) {
        console.error('[Vault] Export failed:', err);
        return { success: false, error: err.message };
      }
    });

    // ── Vault: credential save & autofill IPC handlers ────────────────────────
    const { getIntegrationService: getIS } = await import('@pkg/agent/services/IntegrationService');

    ipc.handle('vault:save-credential', async(_event: Electron.IpcMainInvokeEvent, data: { origin: string; username: string; password: string }) => {
      policy.denyLegacyVaultIpc();
      try {
        const service = getIS();
        await service.initialize();

        // Generate account ID from origin + username
        const accountId = (data.origin + '_' + data.username)
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 200);

        // Save as a website integration account
        await service.setFormValues([
          { integration_id: 'website', account_id: accountId, property: 'website_url', value: data.origin },
          { integration_id: 'website', account_id: accountId, property: 'username', value: data.username },
          { integration_id: 'website', account_id: accountId, property: 'password', value: data.password },
          { integration_id: 'website', account_id: accountId, property: 'llm_access', value: 'autofill' },
        ]);

        // Set account label and mark as connected
        await service.setAccountLabel('website', accountId, `${ data.username } @ ${ data.origin.replace(/^https?:\/\//, '') }`);
        await service.setConnectionStatus('website', true, accountId);

        console.log(`[Vault] Saved credential for ${ data.origin } (${ data.username })`);
        return { success: true, accountId };
      } catch (err: any) {
        console.error('[Vault] Failed to save credential:', err);
        return { success: false, error: err.message };
      }
    });

    ipc.handle('vault:autofill', async(_event: Electron.IpcMainInvokeEvent, data: { tabId?: string; accountId: string }) => {
      policy.denyLegacyVaultIpc();
      try {
        const service = getIS();
        await service.initialize();

        // Get the saved credentials for this account
        const formValues = await service.getFormValues('website', data.accountId);
        const storedValues: Record<string, string> = {};
        for (const fv of formValues) {
          storedValues[fv.property] = fv.value;
        }

        const username = storedValues['username'] || '';
        const password = storedValues['password'] || '';

        if (!username || !password) {
          console.warn('[Vault] Autofill: missing username or password for account', data.accountId);
          return { success: false, error: 'Missing credentials' };
        }

        // Find the active tab to autofill — if tabId provided use it,
        // otherwise find the first visible browser tab with a matching origin
        const targetTabId = data.tabId;

        if (!targetTabId) {
          // Try to find the tab from the main window's rendered browser tabs
          // For now, we'll need the tabId passed from the renderer
          console.warn('[Vault] Autofill: no tabId provided');
          return { success: false, error: 'No target tab specified' };
        }

        // Execute autofill in the target tab — password goes directly to the
        // browser tab via executeJavaScript, never enters the LLM context
        const fillScript = `
          (function() {
            var bridge = window.sullaBridge;
            if (!bridge) return { success: false, error: 'Bridge not available' };

            var loginForm = bridge.detectLoginForm();
            if (!loginForm || !loginForm.hasLoginForm) return { success: false, error: 'No login form found' };

            var usernameOk = false;
            var passwordOk = false;

            if (loginForm.usernameHandle) {
              usernameOk = bridge.setValue(loginForm.usernameHandle, ${ JSON.stringify(username) });
            }
            if (loginForm.passwordHandle) {
              passwordOk = bridge.setValue(loginForm.passwordHandle, ${ JSON.stringify(password) });
            }

            return { success: usernameOk || passwordOk, usernameOk: usernameOk, passwordOk: passwordOk };
          })();
        `;

        const result = await tabViewManager.executeJavaScript(targetTabId, fillScript);
        console.log(`[Vault] Autofill result for ${ data.accountId }:`, result);
        return { success: true, ...(result as any) };
      } catch (err: any) {
        console.error('[Vault] Autofill failed:', err);
        return { success: false, error: err.message };
      }
    });
  }
}
