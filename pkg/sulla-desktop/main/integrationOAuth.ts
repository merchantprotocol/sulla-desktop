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
import { getOAuthService } from '@pkg/agent/services/OAuthService';
import { integrations } from '@pkg/agent/integrations/catalog';
import { pendingIntegrationIds, queuePendingCredential } from '@pkg/main/firstRun/pendingCredentials';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import * as window from '@pkg/window';

const console = Logging.background;

const LOG_PREFIX = '[IntegrationOAuth]';

type FirstRunApiProviderId = 'anthropic' | 'openai' | 'grok';

interface ApiKeyProviderConfig {
  name: string;
  url: string;
  headers(apiKey: string): Record<string, string>;
}

type OAuthFailureReason = 'user-closed' | 'timeout' | 'offline' | 'cli-missing' | 'vm-not-ready' | 'busy-port' | 'no-access' | 'provider-error';

const API_KEY_PROVIDERS: Record<FirstRunApiProviderId, ApiKeyProviderConfig> = {
  anthropic: {
    name: 'Anthropic',
    url: 'https://api.anthropic.com/v1/models',
    headers: apiKey => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
  },
  openai: {
    name: 'OpenAI',
    url: 'https://api.openai.com/v1/models',
    headers: apiKey => ({ Authorization: `Bearer ${ apiKey }` }),
  },
  grok: {
    name: 'Grok',
    url: 'https://api.x.ai/v1/models',
    headers: apiKey => ({ Authorization: `Bearer ${ apiKey }` }),
  },
};

function modelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return [...new Set(data.flatMap(item => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
    ? [(item as { id: string }).id]
    : []))];
}

function chooseDefaultApiModel(providerId: FirstRunApiProviderId, ids: string[]): string | undefined {
  const eligible = ids.filter(id => {
    const lower = id.toLowerCase();
    if (providerId === 'anthropic') return lower.includes('claude') && (lower.includes('sonnet') || lower.includes('opus'));
    if (providerId === 'openai') return lower.startsWith('gpt-') && !/(audio|realtime|transcribe|tts|image|embedding|search|instruct)/.test(lower);
    return lower.startsWith('grok-') && !/(image|embedding)/.test(lower);
  });
  const rank = (id: string) => providerId === 'anthropic'
    ? `${ id.toLowerCase().includes('sonnet') ? '2' : '1' }${ id }`
    : id;
  return eligible.sort((a, b) => rank(b).localeCompare(rank(a), undefined, { numeric: true, sensitivity: 'base' }))[0];
}

function cleanApiKey(value: unknown): { key?: string; error?: string } {
  if (typeof value !== 'string') return {};
  const key = value.replace(/[\s\u200B-\u200D\u2060\uFEFF“”‘’"']/gu, '');
  if (!key) return {};
  if (key.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    return { error: "That doesn't look like a key. Copy it again." };
  }
  return { key };
}

function keyPrefixError(providerId: FirstRunApiProviderId, key: string): string | undefined {
  if (key.startsWith('sk-ant-oat')) return 'That is a Claude sign-in token. Use Claude Connect instead.';
  if (providerId === 'anthropic' && !key.startsWith('sk-ant-')) return key.startsWith('sk-') ? 'That looks like an OpenAI key. Use ChatGPT API instead.' : undefined;
  if (providerId === 'openai' && key.startsWith('sk-ant-')) return 'That looks like an Anthropic key. Use Claude API instead.';
  if (providerId === 'grok' && (key.startsWith('sk-ant-') || key.startsWith('sk-'))) return 'That looks like a different provider key. Use its API option instead.';
  return undefined;
}

function probeRequest(providerId: FirstRunApiProviderId, model: string): { url: string; body: Record<string, unknown> } {
  if (providerId === 'anthropic') {
    return { url: 'https://api.anthropic.com/v1/messages', body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] } };
  }
  return {
    url: providerId === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.x.ai/v1/chat/completions',
    // Newer OpenAI models reject max_tokens; max_completion_tokens works for all.
    body: { model, ...(providerId === 'openai' ? { max_completion_tokens: 16 } : { max_tokens: 1 }), messages: [{ role: 'user', content: 'Hi' }] },
  };
}

function apiResponseError(providerName: string, status: number, text: string): string {
  if (/(insufficient[_ -]?quota|credit balance|billing|payment required|no credit|exceeded your current quota)/i.test(text)) {
    return 'Your key works, but the account has no credit.';
  }
  if (status === 401) return 'That key was not accepted. Check it and try again.';
  if (status === 403) return 'That key cannot use this model. Check its permissions.';
  if (status === 429) return 'The key works but is rate limited right now; try again shortly.';
  return `${ providerName } could not verify that key. Try again.`;
}

function apiFailure(error: unknown, providerName: string): { error: string; errorClass: string } {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError' || error instanceof TypeError) {
    return { error: `Could not reach ${ providerName }. Check your connection.`, errorClass: 'network' };
  }
  return { error: `Could not reach ${ providerName }. Check your connection.`, errorClass: 'network' };
}
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
  ): Promise<{ success: boolean; error?: string; reason?: OAuthFailureReason }> => {
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
            signal: AbortSignal.timeout(15_000),
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
      const reason: OAuthFailureReason = lower.includes('already in use') || lower.includes('eaddrinuse') ? 'busy-port'
        : lower.includes('window closed') || lower.includes('cancel') ? 'user-closed'
          : lower.includes('could not access any models') ? 'no-access'
        : lower.includes('timed out') || lower.includes('timeout') ? 'timeout'
          : lower.includes('offline') || lower.includes('network') || lower.includes('fetch') ? 'offline'
            : lower.includes('vm') && lower.includes('ready') ? 'vm-not-ready' : 'provider-error';
      const error = reason === 'busy-port' ? `Another app is using ${ payload.integrationId === 'codex' ? "ChatGPT's" : "Grok's" } sign-in port. Quit it and try again.`
        : reason === 'no-access' ? `Your ${ payload.integrationId === 'grok' ? 'Grok' : 'AI' } plan cannot use the API.`
          : reason === 'user-closed' ? 'Sign-in was closed.'
        : reason === 'timeout' ? 'Sign-in took too long. Try again.'
          : reason === 'offline' ? 'You appear to be offline. Check your connection and try again.'
            : errMsg.replace(/^\[OAuthService\]\s*/, '');
      firstRunTrace('oauth', 'flow completed', { integrationId: payload?.integrationId, success: false, reason, error });
      return { success: false, error, reason };
    }
  });

  ipcMainProxy.handle('integration-oauth:cancel' as any, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]): boolean => {
    const integrationId = String(args[0] ?? '');
    assertFirstRunOrMainSender(event);
    const cancelled = getOAuthService().cancelFlow(integrationId);
    firstRunTrace('oauth', 'flow cancelled', { integrationId, active: cancelled });
    return cancelled;
  });


  ipcMainProxy.handle('first-run-ai:connect-api-key' as any, async(event: Electron.IpcMainInvokeEvent, ...args: unknown[]): Promise<{ success: boolean; error?: string; models?: string[] }> => {
    const payload = (args[0] ?? {}) as { providerId?: string; apiKey?: string; workspaceId?: string };
    assertFirstRunOrMainSender(event);
    const providerId = payload?.providerId as FirstRunApiProviderId;
    const provider = API_KEY_PROVIDERS[providerId];
    const cleaned = cleanApiKey(payload?.apiKey);
    if (!provider || (!cleaned.key && !cleaned.error)) return { success: false, error: 'Enter an API key to connect.' };
    if (cleaned.error) return { success: false, error: cleaned.error };
    const apiKey = cleaned.key!;
    const prefixError = keyPrefixError(providerId, apiKey);
    if (prefixError) return { success: false, error: prefixError };
    const workspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId.trim() : '';
    const userLevelAnthropicKey = providerId === 'anthropic' && apiKey.startsWith('sk-ant-usr-');
    if (userLevelAnthropicKey && !/^wrkspc_[A-Za-z0-9_-]+$/.test(workspaceId)) {
      return { success: false, error: 'Enter the Workspace ID from Anthropic Settings, Workspaces.' };
    }

    firstRunTrace('api-key', 'verification started', { provider: providerId });
    try {
      const response = await fetch(provider.url, {
        method: 'GET',
        headers: { ...provider.headers(apiKey), ...(userLevelAnthropicKey ? { 'anthropic-workspace-id': workspaceId } : {}) },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (!response.ok) {
        let errorClass = `http-${ response.status }`;
        let error = `${ provider.name } could not verify that key. Try again.`;
        error = apiResponseError(provider.name, response.status, text);
        if (providerId === 'anthropic' && response.status === 400 && /workspace/i.test(text)) {
          errorClass = 'anthropic-workspace';
          error = userLevelAnthropicKey
            ? 'That Workspace ID was not accepted. Find it in the Anthropic console under Settings, Workspaces.'
            : 'This key is not tied to an Anthropic workspace. Create a workspace API key (it starts with sk-ant-api03-) in the Anthropic console.';
        }
        firstRunTrace('api-key', 'verification failed', { provider: providerId, errorClass });
        return { success: false, error };
      }

      let body: unknown;
      try { body = JSON.parse(text); } catch { body = null }
      const models = modelIds(body);
      const model = chooseDefaultApiModel(providerId, models);
      if (!model) {
        firstRunTrace('api-key', 'verification failed', { provider: providerId, errorClass: 'no-chat-model' });
        return { success: false, error: `${ provider.name } accepted the key but returned no supported chat models.` };
      }

      const probe = probeRequest(providerId, model);
      const probeResponse = await fetch(probe.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...provider.headers(apiKey), ...(userLevelAnthropicKey ? { 'anthropic-workspace-id': workspaceId } : {}) },
        body: JSON.stringify(probe.body),
        signal: AbortSignal.timeout(15_000),
      });
      const probeText = probeResponse.ok ? '' : await probeResponse.text();
      // A 400 means the key authenticated and the request shape was refused
      // (model parameters, limits). Only auth, permission and billing failures
      // say anything about the key itself.
      const keyProblem = !probeResponse.ok && (probeResponse.status !== 400 || /(insufficient[_ -]?quota|credit balance|billing|payment required|no credit|exceeded your current quota)/i.test(probeText));
      if (keyProblem) {
        const errorClass = `probe-http-${ probeResponse.status }`;
        firstRunTrace('api-key', 'verification failed', { provider: providerId, errorClass });
        return { success: false, error: apiResponseError(provider.name, probeResponse.status, probeText) };
      }

      queuePendingCredential({
        integrationId: providerId,
        accountId: 'default',
        values: { api_key: apiKey, model, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
        activate: true,
      });
      const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');
      await getModelProviderService().reconcilePrimaryProvider(false, providerId);
      firstRunTrace('api-key', 'verification succeeded', { provider: providerId, model });
      return { success: true, models };
    } catch (error) {
      const failure = apiFailure(error, provider.name);
      firstRunTrace('api-key', 'verification failed', { provider: providerId, errorClass: failure.errorClass });
      return { success: false, error: failure.error };
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
