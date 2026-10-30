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
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import { issueLocalBrokerContext, requireConfiguredCredentialBroker, usesContainerVaultAuthority } from '@pkg/vault-broker';

const console = Logging.background;

const LOG_PREFIX = '[IntegrationOAuth]';
const FIRST_RUN_API_PROVIDERS: Record<string, { integrationId: string; model: string }> = {
  'claude-code': { integrationId: 'anthropic', model: 'claude-sonnet-4-6' },
  codex:         { integrationId: 'openai', model: 'gpt-5.4' },
  grok:          { integrationId: 'grok', model: 'grok-4.7' },
};

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
    },
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const integrationService = getIntegrationService();

      await integrationService.startOAuthFlow(
        payload.integrationId,
        payload.providerId,
        payload.clientId || '',
        payload.clientSecret || '',
        payload.accountId,
        payload.extraScopes,
      );

      console.log(`${ LOG_PREFIX } OAuth flow completed for ${ payload.integrationId }`);

      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`${ LOG_PREFIX } OAuth failed for ${ payload?.integrationId }:`, errMsg);

      return { success: false, error: errMsg };
    }
  });

  /**
   * First-run API fallback. The secret crosses only the trusted renderer/main
   * IPC boundary, then goes straight to the isolated vault. It is never
   * persisted in renderer state, settings, logs, or an agent conversation.
   */
  ipcMainProxy.handle('first-run-ai:save-api-key' as any, async(
    _event: unknown,
    payload: { providerId?: string; apiKey?: string },
  ): Promise<{ success: boolean; error?: string }> => {
    const provider = FIRST_RUN_API_PROVIDERS[payload?.providerId || ''];
    const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';

    if (!provider || !apiKey || apiKey.length > 16_384) {
      return { success: false, error: 'Choose a supported provider and paste a valid API key.' };
    }

    try {
      const accountId = 'api';
      if (usesContainerVaultAuthority()) {
        const context = await issueLocalBrokerContext({
          agentId:         'sulla-desktop-onboarding',
          podId:           'desktop-main',
          credentialScope: { integration_id: provider.integrationId, account_id: accountId },
        });
        const broker = requireConfiguredCredentialBroker();

        await broker.setIntegrationCredential(context, {
          integrationId: provider.integrationId, accountId, property: 'api_key', value: apiKey,
        });
        await broker.setIntegrationCredential(context, {
          integrationId: provider.integrationId, accountId, property: 'model', value: provider.model,
        });
        await broker.setActiveIntegrationAccount(provider.integrationId, accountId);
      } else {
        const service = getIntegrationService();

        await service.setMultipleValues([
          { integration_id: provider.integrationId, account_id: accountId, property: 'api_key', value: apiKey },
          { integration_id: provider.integrationId, account_id: accountId, property: 'model', value: provider.model },
        ]);
        await service.setConnectionStatus(provider.integrationId, true, accountId);
        await service.setActiveAccount(provider.integrationId, accountId);
      }

      const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');

      await getModelProviderService().selectModel(provider.integrationId, provider.model);
      console.log(`${ LOG_PREFIX } First-run API credential saved for ${ provider.integrationId }`);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`${ LOG_PREFIX } First-run API credential save failed:`, message);
      return { success: false, error: message };
    }
  });

  // The existing coordinator records completion against the subscription
  // provider id. Re-apply the API lane after that bookkeeping so it remains
  // the default the user actually connected.
  ipcMainProxy.handle('first-run-ai:activate-api-provider' as any, async(
    _event: unknown, providerId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    const provider = FIRST_RUN_API_PROVIDERS[providerId];
    if (!provider) return { success: false, error: 'Unsupported API provider.' };
    try {
      const service = getIntegrationService();
      await service.setActiveAccount(provider.integrationId, 'api');
      const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');
      await getModelProviderService().selectModel(provider.integrationId, provider.model);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
