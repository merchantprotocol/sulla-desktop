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
import { flushPendingCredentials, pendingIntegrationIds, queuePendingCredential } from '@pkg/main/firstRun/pendingCredentials';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';
import { usesContainerVaultAuthority } from '@pkg/vault-broker';
import * as window from '@pkg/window';

const console = Logging.background;

const LOG_PREFIX = '[IntegrationOAuth]';

type ApiKeyProviderId = 'anthropic' | 'openai' | 'grok' | 'google' | 'groq' | 'mistral' | 'cerebras' | 'together'
  | 'cohere' | 'deepseek' | 'arcee' | 'nvidia' | 'kimi' | 'alibaba' | 'custom';

interface ApiKeyProviderConfig {
  name: string;
  verifyUrl(values: Record<string, string>): string;
  headers(apiKey: string, values: Record<string, string>): Record<string, string>;
  chatModelFilter(id: string, item?: Record<string, unknown>): boolean;
}

type OAuthFailureReason = 'user-closed' | 'timeout' | 'offline' | 'cli-missing' | 'vm-not-ready' | 'busy-port' | 'no-access' | 'provider-error';

const openAiChatModel = (id: string): boolean => !/(audio|realtime|transcri(?:be|ption)|whisper|tts|speech|image|flux|diffusion|embed|rerank|moderation|guard|search)/i.test(id);
const bearer = (apiKey: string): Record<string, string> => ({ Authorization: `Bearer ${ apiKey }` });
const modelsUrl = (baseUrl: string): string => `${ baseUrl.replace(/\/$/, '') }/models`;

function kimiBaseUrl(values: Record<string, string>): string {
  return values.region === 'china' ? 'https://api.moonshot.cn/v1' : 'https://api.moonshot.ai/v1';
}

function alibabaBaseUrl(values: Record<string, string>): string {
  const plan = values.plan || 'payg';
  const region = values.region || 'intl';
  if (plan === 'coding') return region === 'cn'
    ? 'https://coding.dashscope.aliyuncs.com/v1'
    : 'https://coding-intl.dashscope.aliyuncs.com/v1';
  if (region === 'us') return 'https://dashscope-us.aliyuncs.com/compatible-mode/v1';
  if (region === 'cn') return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
}

const API_KEY_PROVIDERS: Record<ApiKeyProviderId, ApiKeyProviderConfig> = {
  anthropic: {
    name: 'Anthropic',
    verifyUrl: () => 'https://api.anthropic.com/v1/models?limit=1000',
    headers: (apiKey, values) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...(apiKey.startsWith('sk-ant-usr-') && values.workspace_id ? { 'anthropic-workspace-id': values.workspace_id } : {}),
    }),
    chatModelFilter: id => /claude/i.test(id) && !/(embed|moderation)/i.test(id),
  },
  openai: {
    name: 'OpenAI', verifyUrl: () => 'https://api.openai.com/v1/models', headers: bearer,
    chatModelFilter: id => /^gpt-|^o\d|^chatgpt-/i.test(id) && openAiChatModel(id),
  },
  grok: {
    name: 'Grok', verifyUrl: () => 'https://api.x.ai/v1/models', headers: bearer,
    chatModelFilter: id => /^grok-/i.test(id) && openAiChatModel(id),
  },
  google: {
    name: 'Google Gemini', verifyUrl: () => 'https://generativelanguage.googleapis.com/v1beta/models',
    headers: apiKey => ({ 'x-goog-api-key': apiKey }),
    chatModelFilter: (id, item) => /^gemini-/i.test(id) && (!Array.isArray(item?.supportedGenerationMethods) || item.supportedGenerationMethods.includes('generateContent')),
  },
  groq: {
    name: 'Groq', verifyUrl: () => 'https://api.groq.com/openai/v1/models', headers: bearer,
    chatModelFilter: openAiChatModel,
  },
  mistral: {
    name: 'Mistral AI', verifyUrl: () => 'https://api.mistral.ai/v1/models', headers: bearer,
    chatModelFilter: openAiChatModel,
  },
  cerebras: {
    name: 'Cerebras', verifyUrl: () => 'https://api.cerebras.ai/v1/models', headers: bearer,
    chatModelFilter: openAiChatModel,
  },
  together: {
    name: 'Together AI', verifyUrl: () => 'https://api.together.xyz/v1/models', headers: bearer,
    chatModelFilter: openAiChatModel,
  },
  cohere: {
    name: 'Cohere', verifyUrl: () => 'https://api.cohere.com/v2/models', headers: bearer,
    chatModelFilter: (id, item) => !Array.isArray(item?.endpoints) || item.endpoints.some(endpoint => String(endpoint).toLowerCase().includes('chat')),
  },
  deepseek: {
    name: 'DeepSeek', verifyUrl: () => 'https://api.deepseek.com/models', headers: bearer,
    chatModelFilter: openAiChatModel,
  },
  arcee: {
    name: 'Arcee AI', verifyUrl: () => 'https://api.arcee.ai/api/v1/models', headers: bearer,
    chatModelFilter: openAiChatModel,
  },
  nvidia: {
    name: 'NVIDIA', verifyUrl: () => 'https://integrate.api.nvidia.com/v1/models', headers: bearer,
    chatModelFilter: openAiChatModel,
  },
  kimi: {
    name: 'Kimi', verifyUrl: values => modelsUrl(kimiBaseUrl(values)), headers: bearer,
    chatModelFilter: openAiChatModel,
  },
  alibaba: {
    name: 'Alibaba Cloud', verifyUrl: values => modelsUrl(alibabaBaseUrl(values)), headers: bearer,
    chatModelFilter: openAiChatModel,
  },
  custom: {
    name: 'Custom provider',
    verifyUrl: values => modelsUrl(values.base_url || ''),
    headers: apiKey => apiKey ? bearer(apiKey) : {},
    chatModelFilter: openAiChatModel,
  },
};

function modelEntries(body: unknown): { id: string; item: Record<string, unknown> }[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as { data?: unknown; models?: unknown };
  const data = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  const entries = data.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const object = item as Record<string, unknown>;
    const rawId = typeof object.id === 'string' ? object.id : typeof object.name === 'string' ? object.name : '';
    const id = rawId.replace(/^models\//, '');
    return id ? [{ id, item: object }] : [];
  });
  return [...new Map(entries.map(entry => [entry.id, entry])).values()];
}

function verifiedChatModels(provider: ApiKeyProviderConfig, body: unknown): string[] {
  return modelEntries(body).filter(({ id, item }) => provider.chatModelFilter(id, item)).map(({ id }) => id);
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

function keyPrefixError(providerId: ApiKeyProviderId, key: string): string | undefined {
  if (key.startsWith('sk-ant-oat')) return 'That is a Claude sign-in token. Use Claude Connect instead.';
  if (providerId === 'anthropic' && !key.startsWith('sk-ant-')) return key.startsWith('sk-') ? 'That looks like an OpenAI key. Use ChatGPT API instead.' : undefined;
  if (providerId === 'openai' && key.startsWith('sk-ant-')) return 'That looks like an Anthropic key. Use Claude API instead.';
  if (providerId === 'grok' && (key.startsWith('sk-ant-') || key.startsWith('sk-'))) return 'That looks like a different provider key. Use its API option instead.';
  return undefined;
}

function probeRequest(providerId: 'anthropic' | 'openai' | 'grok', model: string): { url: string; body: Record<string, unknown> } {
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
  if (status === 401 || status === 403) return 'That key was not accepted.';
  if (/(insufficient[_ -]?quota|credit balance|billing|payment required|no credit|exceeded your current quota)/i.test(text)) {
    return 'Your key works, but the account has no credit.';
  }
  if (status === 429) return 'The key works but is rate limited right now; try again shortly.';
  return `${ providerName } could not verify that key. Try again.`;
}

function apiFailure(error: unknown, providerName: string): { error: string; errorClass: string } {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError' || error instanceof TypeError) {
    return { error: `Could not reach ${ providerName }.`, errorClass: 'network' };
  }
  return { error: `Could not reach ${ providerName }.`, errorClass: 'network' };
}
interface ApiKeyVerification {
  models?: string[];
  error?: string;
  errorClass?: string;
}

async function verifyApiKey(providerId: ApiKeyProviderId, apiKey: string, values: Record<string, string>): Promise<ApiKeyVerification> {
  const provider = API_KEY_PROVIDERS[providerId];
  const userLevelAnthropicKey = providerId === 'anthropic' && apiKey.startsWith('sk-ant-usr-');
  if (userLevelAnthropicKey && !/^wrkspc_[A-Za-z0-9_-]+$/.test(values.workspace_id || '')) {
    return { error: 'Enter the Workspace ID from Anthropic Settings, Workspaces.', errorClass: 'anthropic-workspace' };
  }
  let url: string;
  try {
    url = provider.verifyUrl(values);
    // Custom endpoints are user-entered, but they still must be absolute URLs.
    new URL(url);
  } catch {
    return { error: `Could not reach ${ provider.name }. Check the server address.`, errorClass: 'network' };
  }
  try {
    const response = await fetch(url, {
      headers: provider.headers(apiKey, values),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) {
      if (providerId === 'anthropic' && response.status === 400 && /workspace/i.test(text)) {
        return {
          error: userLevelAnthropicKey
            ? 'That Workspace ID was not accepted. Find it in the Anthropic console under Settings, Workspaces.'
            : 'This key is not tied to an Anthropic workspace. Create a workspace API key (it starts with sk-ant-api03-) in the Anthropic console.',
          errorClass: 'anthropic-workspace',
        };
      }
      if ((providerId === 'kimi' || providerId === 'alibaba') && (response.status === 401 || response.status === 403)) {
        return {
          error: 'That key belongs to a different region. Pick the region you created it in.',
          errorClass: 'region-mismatch',
        };
      }
      return { error: apiResponseError(provider.name, response.status, text), errorClass: `http-${ response.status }` };
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = null }
    const models = verifiedChatModels(provider, body);
    if (!models.length) return {
      error: `${ provider.name } accepted the key but returned no supported chat models.`,
      errorClass: 'no-chat-model',
    };

    // NVIDIA's model catalog and Alibaba's Coding Plan catalog are public.
    // A one-token chat probe is therefore required before a key can be saved.
    if (providerId === 'nvidia' || (providerId === 'alibaba' && (values.plan || 'payg') === 'coding')) {
      const baseUrl = providerId === 'nvidia' ? 'https://integrate.api.nvidia.com/v1' : alibabaBaseUrl(values);
      const probeResponse = await fetch(`${ baseUrl }/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...provider.headers(apiKey, values) },
        body: JSON.stringify({ model: models[0], max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (probeResponse.status === 401 || probeResponse.status === 403) {
        if (providerId === 'alibaba') return {
          error: 'That key belongs to a different region. Pick the region you created it in.',
          errorClass: 'region-mismatch',
        };
        return { error: apiResponseError(provider.name, probeResponse.status, await probeResponse.text()), errorClass: `http-${ probeResponse.status }` };
      }
    }
    return { models };
  } catch (error) {
    return apiFailure(error, provider.name);
  }
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


  ipcMainProxy.handle('integration:connect-form', async(event: Electron.IpcMainInvokeEvent, ...args: unknown[]): Promise<{ success: boolean; error?: string }> => {
    assertFirstRunOrMainSender(event);
    const payload = (args[0] ?? {}) as { integrationId?: unknown; accountId?: unknown; label?: unknown; values?: unknown };
    const integrationId = typeof payload.integrationId === 'string' ? payload.integrationId.trim() : '';
    const accountId = typeof payload.accountId === 'string' ? payload.accountId.trim() : '';
    const label = typeof payload.label === 'string' ? payload.label.trim() : '';
    const integration = integrations[integrationId];
    if (!integration || !/^[a-z0-9][a-z0-9_-]*$/i.test(accountId) || !label) {
      return { success: false, error: 'Enter an account label and try again.' };
    }

    const supplied = payload.values && typeof payload.values === 'object' && !Array.isArray(payload.values)
      ? payload.values as Record<string, unknown>
      : {};
    const properties = integration.properties ?? [];
    const allowed = new Set(properties.map(property => property.key));
    const values: Record<string, string> = { account_label: label };
    for (const property of properties) {
      const raw = supplied[property.key];
      const value = typeof raw === 'string' ? raw : '';
      if (property.required && property.type !== 'select' && !value.trim()) return { success: false, error: `${ property.title } is required.` };
      if (value) values[property.key] = value;
    }
    for (const key of Object.keys(supplied)) {
      if (key !== 'llm_access' && !allowed.has(key)) return { success: false, error: 'The connection form contained an unexpected field. Reload it and try again.' };
    }
    values.llm_access = 'autofill';
    const apiProvider = API_KEY_PROVIDERS[integrationId as ApiKeyProviderId];
    if (apiProvider) {
      const cleaned = cleanApiKey(values.api_key);
      const keyOptional = integrationId === 'custom';
      if (cleaned.error || (!cleaned.key && !keyOptional)) {
        return { success: false, error: cleaned.error || `Enter a ${ apiProvider.name } API key to connect.` };
      }
      const apiKey = cleaned.key || '';
      if (apiKey) {
        values.api_key = apiKey;
        const prefixError = keyPrefixError(integrationId as ApiKeyProviderId, apiKey);
        if (prefixError) return { success: false, error: prefixError };
      }
      const verification = await verifyApiKey(integrationId as ApiKeyProviderId, apiKey, values);
      if (verification.error) return { success: false, error: verification.error };
      if (!values.model && verification.models?.[0]) values.model = verification.models[0];
    }

    try {
      if (usesContainerVaultAuthority()) {
        queuePendingCredential({ integrationId, accountId, values, activate: true });
        const flushed = await flushPendingCredentials();
        if (!flushed.flushed.includes(integrationId)) {
          return { success: false, error: 'The vault is locked or unavailable. Unlock it, then try again.' };
        }
      } else {
        const service = getIntegrationService();
        await service.setAccountLabel(integrationId, accountId, label);
        await service.setFormValues(Object.entries(values)
          .filter(([property]) => property !== 'account_label')
          .map(([property, value]) => ({ integration_id: integrationId, account_id: accountId, property, value })));
        await service.setConnectionStatus(integrationId, true, accountId);
        const accounts = await service.getAccounts(integrationId);
        if (accounts.length <= 1) await service.setActiveAccount(integrationId, accountId);
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${ LOG_PREFIX } Inline connection failed for ${ integrationId }:`, message);
      return { success: false, error: /locked/i.test(message)
        ? 'The vault is locked. Unlock it, then try again.'
        : `Could not save ${ integration.name }. ${ message.replace(/^Error:\s*/i, '') }` };
    }
  });

  ipcMainProxy.handle('first-run-ai:connect-api-key' as any, async(event: Electron.IpcMainInvokeEvent, ...args: unknown[]): Promise<{ success: boolean; error?: string; models?: string[] }> => {
    const payload = (args[0] ?? {}) as { providerId?: string; apiKey?: string; workspaceId?: string };
    assertFirstRunOrMainSender(event);
    const providerId = payload.providerId as ApiKeyProviderId;
    const provider = API_KEY_PROVIDERS[providerId];
    const cleaned = cleanApiKey(payload.apiKey);
    if (!provider || (!cleaned.key && !cleaned.error)) return { success: false, error: 'Enter an API key to connect.' };
    if (cleaned.error) return { success: false, error: cleaned.error };
    const apiKey = cleaned.key!;
    const prefixError = keyPrefixError(providerId, apiKey);
    if (prefixError) return { success: false, error: prefixError };
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : '';
    const values = { api_key: apiKey, ...(workspaceId ? { workspace_id: workspaceId } : {}) };

    firstRunTrace('api-key', 'verification started', { provider: providerId });
    const verification = await verifyApiKey(providerId, apiKey, values);
    if (verification.error || !verification.models?.length) {
      firstRunTrace('api-key', 'verification failed', { provider: providerId, errorClass: verification.errorClass || 'no-chat-model' });
      return { success: false, error: verification.error || `${ provider.name } accepted the key but returned no supported chat models.` };
    }
    const models = verification.models;
    const model = models[0];

    // First run currently offers these three providers. Keep its one-token
    // capability probe while sharing the same model-list verification table.
    if (providerId === 'anthropic' || providerId === 'openai' || providerId === 'grok') {
      try {
        const probe = probeRequest(providerId, model);
        const probeResponse = await fetch(probe.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...provider.headers(apiKey, values) },
          body: JSON.stringify(probe.body),
          signal: AbortSignal.timeout(15_000),
        });
        const probeText = probeResponse.ok ? '' : await probeResponse.text();
        const keyProblem = !probeResponse.ok && (probeResponse.status !== 400 || /(insufficient[_ -]?quota|credit balance|billing|payment required|no credit|exceeded your current quota)/i.test(probeText));
        if (keyProblem) {
          firstRunTrace('api-key', 'verification failed', { provider: providerId, errorClass: `probe-http-${ probeResponse.status }` });
          return { success: false, error: apiResponseError(provider.name, probeResponse.status, probeText) };
        }
      } catch (error) {
        const failure = apiFailure(error, provider.name);
        firstRunTrace('api-key', 'verification failed', { provider: providerId, errorClass: failure.errorClass });
        return { success: false, error: failure.error };
      }
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
