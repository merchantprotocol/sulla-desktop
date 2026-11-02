// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { app, BrowserWindow } from 'electron';

import { isSullaRuntimeActive } from '@pkg/backend/sullaRuntime/state';
import { withSuppressedConnectionStatus } from '@pkg/agent/integrations/integrationFlags';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { queuePendingCredential } from '@pkg/main/firstRun/pendingCredentials';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import { ClaudeOAuthCoordinator } from '@pkg/main/oauth/claude/ClaudeOAuthCoordinator';
import { claudeOAuthFailure, type ClaudeOAuthResult } from '@pkg/utils/claudeOAuthContract';
import Logging from '@pkg/utils/logging';
import * as window from '@pkg/window';
import { getConfiguredApprovalClient, usesContainerVaultAuthority } from '@pkg/vault-broker';

const CLAUDE_INTEGRATION_ID = 'claude-code';
const CLAUDE_OAUTH_ACCOUNT_ID = 'oauth';
const console = Logging.background;

function assertFirstRunOrMainSender(event: Electron.IpcMainInvokeEvent): void {
  const sender = BrowserWindow.fromWebContents(event.sender);

  if (sender !== window.getWindow('first-run') && sender !== window.getWindow('main-agent')) throw new Error('Claude OAuth is only available from a trusted Sulla window');
}

async function persistTokenToVault(token: string): Promise<void> {
  if (usesContainerVaultAuthority()) {
    const client = getConfiguredApprovalClient();

    if (!client) throw new Error('Desktop vault session service is unavailable');
    await client.importIntegrationAccount(CLAUDE_INTEGRATION_ID, {
      accountId: CLAUDE_OAUTH_ACCOUNT_ID,
      label: 'Claude Code OAuth',
      values: { oauth_token: token, api_key: '', account_label: 'Claude Code OAuth' },
      active: true,
      connected: true,
    });
    return;
  }
  const service = getIntegrationService();

  await withSuppressedConnectionStatus(async() => {
    await service.setMultipleValues([
      { integration_id: CLAUDE_INTEGRATION_ID, account_id: CLAUDE_OAUTH_ACCOUNT_ID, property: 'oauth_token', value: token },
      { integration_id: CLAUDE_INTEGRATION_ID, account_id: CLAUDE_OAUTH_ACCOUNT_ID, property: 'api_key', value: '' },
      { integration_id: CLAUDE_INTEGRATION_ID, account_id: CLAUDE_OAUTH_ACCOUNT_ID, property: 'account_label', value: 'Claude Code OAuth' },
    ]);
    await service.setConnectionStatus(CLAUDE_INTEGRATION_ID, true, CLAUDE_OAUTH_ACCOUNT_ID);
    await service.setActiveAccount(CLAUDE_INTEGRATION_ID, CLAUDE_OAUTH_ACCOUNT_ID);
  });
}

async function saveToken(token: string, firstRun: boolean): Promise<void> {
  if (!firstRun) {
    await persistTokenToVault(token);
    return;
  }
  await queuePendingCredential({
    integrationId: CLAUDE_INTEGRATION_ID,
    accountId: CLAUDE_OAUTH_ACCOUNT_ID,
    values: { oauth_token: token, api_key: '', account_label: 'Claude Code OAuth' },
    activate: true,
  });
  const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');

  await getModelProviderService().reconcilePrimaryProvider(false, CLAUDE_INTEGRATION_ID);
}

const coordinator = new ClaudeOAuthCoordinator(saveToken);

async function runE2EFlow(options?: { firstRun?: boolean }): Promise<ClaudeOAuthResult> {
  if (process.env.SULLA_E2E_OAUTH_RESULT === 'closed') return claudeOAuthFailure('cancelled', 'Sign-in was closed.');
  const endpoint = process.env.SULLA_E2E_OAUTH_URL;

  if (!endpoint) return claudeOAuthFailure('provider_error', 'Sign-in is unavailable.');
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ integrationId: CLAUDE_INTEGRATION_ID }) });

    if (!response.ok) return claudeOAuthFailure('provider_error', 'Sign-in failed.');
    const tokens = await response.json() as Record<string, string>;
    const token = tokens.oauth_token;

    if (!token) return claudeOAuthFailure('provider_error', 'Sign-in returned no token.');
    await saveToken(token, !!options?.firstRun);
    return { status: 'success', success: true };
  } catch {
    return claudeOAuthFailure('provider_error', 'Sign-in failed.');
  }
}

export function initClaudeOAuthEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);

  ipcMainProxy.handle('claude-oauth:start', async(event: Electron.IpcMainInvokeEvent, options?: { firstRun?: boolean }): Promise<ClaudeOAuthResult> => {
    try {
      assertFirstRunOrMainSender(event);
      const vmRunning = isSullaRuntimeActive();

      firstRunTrace('claude', 'flow started', { firstRun: !!options?.firstRun, vmRunning });
      if (!(app?.isPackaged ?? true) && process.env.SULLA_E2E === '1') return await runE2EFlow(options);
      if (!vmRunning) return claudeOAuthFailure('vm_not_ready', 'Your private workspace is still starting. Try again in a moment.');
      return await coordinator.start(event, options);
    } catch (error) {
      console.warn('[ClaudeOAuth] Start failed:', error);
      return claudeOAuthFailure('provider_error', 'Claude sign-in could not start. Try again.');
    }
  });

  ipcMainProxy.handle('claude-oauth:cancel', async(event: Electron.IpcMainInvokeEvent): Promise<ClaudeOAuthResult> => {
    try {
      assertFirstRunOrMainSender(event);
      return coordinator.cancel(event);
    } catch {
      return claudeOAuthFailure('provider_error', 'Claude sign-in could not be cancelled.');
    }
  });
}
