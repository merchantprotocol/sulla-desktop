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

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { pendingIntegrationIds, queuePendingCredential } from '@pkg/main/firstRun/pendingCredentials';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

const LOG_PREFIX = '[IntegrationOAuth]';
export function initIntegrationOAuthEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);

  /**
   * Start a generic integration OAuth flow in the main process. Delegates to
   * IntegrationService.startOAuthFlow → OAuthService.startFlow, which owns the
   * callback server, the embedded auth window, token exchange, and marking the
   * integration connected.
   */
  ipcMainProxy.handle('integration-oauth:start', async(
    _event: unknown,
    payload: {
      integrationId: string;
      providerId:    string;
      clientId?:     string;
      clientSecret?: string;
      accountId?:    string;
      extraScopes?:  string[];
      firstRun?:     boolean;
    },
  ): Promise<{ success: boolean; error?: string }> => {
    try {
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
        queuePendingCredential({
          integrationId: payload.integrationId, accountId: payload.accountId || 'oauth', values, activate: true,
        });
      }

      console.log(`${ LOG_PREFIX } OAuth flow completed for ${ payload.integrationId }`);

      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`${ LOG_PREFIX } OAuth failed for ${ payload?.integrationId }:`, errMsg);

      return { success: false, error: errMsg };
    }
  });

  ipcMainProxy.handle('first-run-ai:connection-status' as any, async(): Promise<{ pending: string[]; connected: boolean; loading: boolean }> => {
    const pending = pendingIntegrationIds();
    try {
      const service = getIntegrationService();
      const providerIds = ['claude-code', 'codex', 'grok', 'anthropic', 'openai'];
      const accounts = await Promise.all(providerIds.map(id => service.getAccounts(id)));
      return { pending, connected: pending.length > 0 || accounts.flat().some(account => account.connected), loading: false };
    } catch {
      return { pending, connected: pending.length > 0, loading: true };
    }
  });
}
