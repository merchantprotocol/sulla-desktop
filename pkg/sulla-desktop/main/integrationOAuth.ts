// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Generic integration OAuth handler.
 *
 * Runs the full OAuth flow in the MAIN process so providers that render their
 * sign-in page in an embedded Electron window (openInEmbeddedWindow: true —
 * e.g. OpenAI Codex and Grok) can actually construct it. `BrowserWindow` is a
 * main-process-only API: the renderer previously called
 * IntegrationService.startOAuthFlow() directly, which tried to
 * `new BrowserWindow()` inside the renderer and threw
 * "BrowserWindow is not a constructor".
 *
 * The dedicated claude-oauth / openai-oauth handlers already dodge this by
 * going over IPC to main; this is the same bridge for every other
 * YAML/OAuth-manifest provider.
 */

import { app, BrowserWindow } from 'electron';

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { integrations } from '@pkg/agent/integrations/catalog';
import { pendingIntegrationIds, queuePendingCredential } from '@pkg/main/firstRun/pendingCredentials';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import * as window from '@pkg/window';

const console = Logging.background;

const LOG_PREFIX = '[IntegrationOAuth]';
function assertFirstRunOrMainSender(event: Electron.IpcMainInvokeEvent): void {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (sender !== window.getWindow('first-run') && sender !== window.getWindow('main-agent')) {
    throw new Error('AI connection is only available from a trusted Sulla window');
  }
}

export function initIntegrationOAuthEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);

  /**
   * Start a generic integration OAuth flow in the main process. Delegates to
   * IntegrationService.startOAuthFlow → OAuthService.startFlow, which owns the
   * callback server, the embedded auth window, token exchange, and marking the
   * integration connected.
   */
  ipcMainProxy.handle('integration-oauth:start', async(
    event: Electron.IpcMainInvokeEvent,
    payload: {
      integrationId: string;
      providerId:    string;
      clientId?:     string;
      clientSecret?: string;
      accountId?:    string;
      extraScopes?:  string[];
      firstRun?:     boolean;
    },
  ): Promise<{ success: boolean; error?: string; reason?: 'user-closed' | 'timeout' | 'offline' | 'cli-missing' | 'vm-not-ready' | 'provider-error' }> => {
    firstRunTrace('oauth', 'flow started', { integrationId: payload.integrationId, providerId: payload.providerId, firstRun: !!payload.firstRun });
    if (!(app?.isPackaged ?? true) && process.env.SULLA_E2E === '1') {
      if (process.env.SULLA_E2E_OAUTH_RESULT === 'closed') return { success: false, error: 'Sign-in was closed.', reason: 'user-closed' };
      const endpoint = process.env.SULLA_E2E_OAUTH_URL;
      if (!endpoint) return { success: false, error: 'Sign-in is unavailable.', reason: 'provider-error' };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ integrationId: payload.integrationId }) });
      if (!response.ok) return { success: false, error: 'Sign-in failed.', reason: 'provider-error' };
      const tokens = await response.json() as Record<string, string>;
      queuePendingCredential({ integrationId: payload.integrationId, accountId: payload.accountId || 'oauth', values: tokens, activate: true });
      return { success: true };
    }
    try {
      if (payload.firstRun) assertFirstRunOrMainSender(event);
      const integrationService = getIntegrationService();

      const tokens = await integrationService.startOAuthFlow(
        payload.integrationId,
        payload.providerId,
        payload.clientId || '',
        payload.clientSecret || '',
        payload.accountId,
        payload.extraScopes,
        !payload.firstRun,
      );

      if (payload.firstRun) {
        const values = Object.fromEntries(Object.entries(tokens)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, typeof value === 'string' ? value : String(value)]));
        values.provider_id = payload.providerId;
        if (payload.integrationId === 'grok') {
          const { GROK_SUBSCRIPTION_BASE_URL, grokCliHeaders } = await import('@pkg/agent/languagemodels/GrokService');
          const response = await fetch(`${ GROK_SUBSCRIPTION_BASE_URL }/models`, {
            headers: { Authorization: `Bearer ${ values.access_token }`, ...grokCliHeaders() },
          });
          const body = response.ok ? await response.json() as { data?: { id?: string }[] } : null;
          const model = body?.data?.find(item => typeof item.id === 'string' && item.id)?.id;
          if (!model) throw new Error('Grok signed in, but the account could not access any models');
          values.model = model;
        }
        queuePendingCredential({
          integrationId: payload.integrationId, accountId: payload.accountId || 'oauth', values, activate: true,
        });
        firstRunTrace('oauth', 'credentials queued', { integrationId: payload.integrationId, custody: 'pending' });
        const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');
        await getModelProviderService().reconcilePrimaryProvider(false, payload.integrationId);
        firstRunTrace('oauth', 'provider reconcile called', { integrationId: payload.integrationId });
        if (payload.integrationId === 'codex') {
          const { writeCodexAuthFile, linkCodexHomeIntoVm } = await import('@pkg/agent/util/codexAuthFile');
          if (!writeCodexAuthFile(tokens)) throw new Error('ChatGPT sign-in did not return usable credentials');
          // The VM may still be starting during first run. The sign-in is kept;
          // ensureCodexAuthFile() links it into the VM before the first Codex turn.
          const linked = await linkCodexHomeIntoVm().catch(() => false);
          firstRunTrace('codex', 'auth file prepared', { written: true, linked });
          if (!linked) console.log(`${ LOG_PREFIX } Codex sign-in saved; it will be linked into the VM once it is ready`);
        }
      }

      console.log(`${ LOG_PREFIX } OAuth flow completed for ${ payload.integrationId }`);

      firstRunTrace('oauth', 'flow completed', { integrationId: payload.integrationId, success: true, custody: payload.firstRun ? 'pending' : 'persisted' });
      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`${ LOG_PREFIX } OAuth failed for ${ payload?.integrationId }:`, errMsg);

      const lower = errMsg.toLowerCase();
      const reason = lower.includes('window closed') || lower.includes('cancel') ? 'user-closed'
        : lower.includes('timed out') || lower.includes('timeout') ? 'timeout'
          : lower.includes('offline') || lower.includes('network') || lower.includes('fetch') ? 'offline'
            : lower.includes('vm') && lower.includes('ready') ? 'vm-not-ready' : 'provider-error';
      const error = reason === 'user-closed' ? 'Sign-in was closed.'
        : reason === 'timeout' ? 'Sign-in took too long. Try again.'
          : reason === 'offline' ? 'You appear to be offline. Check your connection and try again.'
            : errMsg.replace(/^\[OAuthService\]\s*/, '');
      firstRunTrace('oauth', 'flow completed', { integrationId: payload?.integrationId, success: false, reason, error });
      return { success: false, error, reason };
    }
  });

  ipcMainProxy.handle('first-run-ai:connection-status' as any, async(event: Electron.IpcMainInvokeEvent): Promise<{ pending: string[]; connected: boolean; loading: boolean }> => {
    assertFirstRunOrMainSender(event);
    const aiProviderIds = new Set([
      'claude-code', 'codex',
      ...Object.values(integrations).filter(integration => integration.category === 'AI Infrastructure').map(integration => integration.id),
    ]);
    const pending = pendingIntegrationIds().filter(id => aiProviderIds.has(id));
    try {
      const service = getIntegrationService();
      const providerIds = [...aiProviderIds];
      const accountResults = await Promise.allSettled(providerIds.map(id => service.getAccounts(id)));
      const accounts = accountResults.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      return { pending, connected: pending.length > 0 || accounts.some(account => account.connected), loading: false };
    } catch {
      return { pending, connected: pending.length > 0, loading: true };
    }
  });
}
