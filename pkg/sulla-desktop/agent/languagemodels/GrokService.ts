// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { type ChatMessage, type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { usesContainerVaultAuthority } from '../../vault-broker';
import { getIntegrationService } from '../services/IntegrationService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

import type { BrokerInjection } from '../../vault-broker';
import { firstRunTrace } from '../../main/firstRun/firstRunTrace';

/**
 * xAI Grok LLM provider.
 *
 * xAI runs two separate billing lanes and they do NOT share entitlements:
 *
 * - Metered API — https://api.x.ai/v1, OpenAI-compatible /chat/completions,
 *   Bearer = pasted API key, billed per token against prepaid credits.
 * - Subscription lane — https://cli-chat-proxy.grok.com/v1, the Grok CLI
 *   ("Grok Build") proxy that bills against a SuperGrok / X Premium+
 *   subscription. Bearer = the auth.x.ai OAuth access token. Speaks the
 *   OpenAI *Responses* API only (/responses; /chat/completions on that host
 *   forwards to the metered lane and 403s subscription-only accounts).
 *
 * Sending the OAuth token to api.x.ai yields 403
 * "personal-team-blocked:spending-limit" even with an active SuperGrok sub —
 * verified live 2026-07-10. OAuth mode therefore hardcodes the proxy lane.
 */
export const GROK_METERED_BASE_URL = 'https://api.x.ai/v1';
export const GROK_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';

/**
 * Client version the proxy's version gate accepts. It parses the version out
 * of User-Agent and rejects requests without one via HTTP 426 "version
 * (none)". Pinned to the version the official Grok CLI emits (same value
 * pi-grok-cli ships); expect xAI to ratchet the minimum over time — a 426
 * from the proxy means bump this constant.
 */
export const GROK_CLI_VERSION = '1.0.13';
export const GROK_CLI_USER_AGENT = `grok-pager/${ GROK_CLI_VERSION } grok-shell/${ GROK_CLI_VERSION } (macos; aarch64)`;

/** xAI server-side search tools. These execute remotely and never enter Sulla's ToolExecutor. */
export const GROK_NATIVE_SEARCH_TOOLS = [
  { type: 'x_search' },
  { type: 'web_search' },
] as const;

/** Context windows advertised by the proxy's /models catalog (2026-07). */
const GROK_SUBSCRIPTION_CONTEXT_WINDOWS: Record<string, number> = {
  'grok-4.5':               500_000,
  'grok-composer-2.5-fast': 200_000,
};

/**
 * Identification headers the subscription proxy requires on EVERY request
 * (models list, /responses, /billing). Missing/invalid → HTTP 426.
 * `modelId` adds x-grok-model-override; omit it for non-inference calls.
 */
export function grokCliHeaders(modelId?: string): Record<string, string> {
  return {
    'User-Agent':               GROK_CLI_USER_AGENT,
    'x-grok-client-identifier': 'grok-pager',
    'x-grok-client-version':    GROK_CLI_VERSION,
    'x-xai-token-auth':         'xai-grok-cli',
    ...(modelId ? { 'x-grok-model-override': modelId } : {}),
  };
}

export class GrokService extends OpenAICompatibleService {
  static async create(): Promise<GrokService> {
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues('grok');
    const valMap: Record<string, string> = {};
    for (const v of values) {
      valMap[v.property] = v.value;
    }

    // Prefer the OAuth session (Sign in with Grok) over a pasted API key.
    // getOAuthAccessToken auto-refreshes when expired; GrokOAuth's
    // onTokenReceived busts this cached instance on every refresh so a live
    // token is re-read here. The UI stores OAuth tokens under the fixed
    // 'oauth' account id (see AgentIntegrationDetail.handleOAuthConnect).
    let accountId = await integrationService.getActiveAccountId('grok');
    let apiKey = valMap.api_key || '';
    let oauthMode = false;
    try {
      const { getPendingCredential } = await import('../../main/firstRun/pendingCredentials');
      const pending = getPendingCredential('grok');
      if (pending?.values.access_token) {
        apiKey = pending.values.access_token;
        if (pending.values.model) valMap.model = pending.values.model;
        oauthMode = true;
        firstRunTrace('grok', 'credentials resolved', { source: 'pending', oauthMode: true });
      } else if (pending?.values.api_key) {
        apiKey = pending.values.api_key;
        if (pending.values.model) valMap.model = pending.values.model;
        firstRunTrace('grok', 'credentials resolved', { source: 'pending', oauthMode: false });
      }
    } catch { /* pending credentials exist only in the main process */ }
    if (!oauthMode && usesContainerVaultAuthority()) {
      const oauthAccount = (await integrationService.getAccounts('grok'))
        .find(account => account.account_id === 'oauth' && account.connected);
      if (oauthAccount) {
        accountId = oauthAccount.account_id;
        oauthMode = true;
      }
    } else if (!oauthMode) {
      try {
        apiKey = await integrationService.getOAuthAccessToken('grok', 'oauth');
        accountId = 'oauth';
        oauthMode = true;
      } catch { /* not OAuth-connected — fall back to api_key */ }
    }

    let model = valMap.model || '';
    if (oauthMode) {
      // The proxy only serves the subscription catalog. A model saved while
      // on the metered lane (grok-2/grok-3 families) would 404/403 there —
      // choose the first model returned by the live subscription catalog.
      if (!model || /^grok-[23]/.test(model)) {
        let body: { data?: { id?: string }[] } | null = null;
        if (apiKey) {
          const response = await fetch(`${ GROK_SUBSCRIPTION_BASE_URL }/models`, {
            headers: { Authorization: `Bearer ${ apiKey }`, ...grokCliHeaders() },
          });
          body = response.ok ? await response.json() as { data?: { id?: string }[] } : null;
        } else if (usesContainerVaultAuthority()) {
          const { listProviderModelsBrokered } = await import('../services/brokeredModelList');
          body = (await listProviderModelsBrokered<{ data?: { id?: string }[] }>('grok', accountId, () => grokCliHeaders())).body;
        }
        model = body?.data?.find(item => typeof item.id === 'string' && item.id)?.id || '';
        if (!model) throw new Error('Grok did not return an available model');
      }
    }

    const nativeSearch = await SullaSettingsModel.get('grokNativeSearch', true);
    firstRunTrace('grok', 'credentials resolved', { source: oauthMode ? (apiKey ? 'vault' : 'vault-bridge') : (apiKey ? 'vault-api-key' : 'none'), oauthMode, model });

    return new GrokService({
      id:      'grok',
      model,
      baseUrl: oauthMode ? GROK_SUBSCRIPTION_BASE_URL : GROK_METERED_BASE_URL,
      apiKey,
      accountId,
    }, oauthMode, nativeSearch !== false);
  }

  private nativeSearchSupported = true;

  constructor(
    config: LLMServiceConfig,
    private readonly oauthMode = false,
    private readonly nativeSearchEnabled = true,
  ) {
    super(config);
  }

  override getProviderName(): string {
    return 'Grok';
  }

  override getContextWindow(): number {
    return GROK_SUBSCRIPTION_CONTEXT_WINDOWS[this.model] ?? super.getContextWindow();
  }

  /**
   * Vault mode: the subscription lane's OAuth token lives in the vault, so
   * refresh it there before it expires rather than sending a dead token.
   */
  protected override async beforeProviderRequest(): Promise<void> {
    if (!this.oauthMode || !this.accountId || !usesContainerVaultAuthority()) return;
    const { getOAuthService } = await import('../services/OAuthService');
    await getOAuthService().ensureVaultTokenFresh('grok', this.accountId);
  }

  /** On a 401 in vault mode, force a vault refresh so the retry uses a new token. */
  override async refreshCredentials(): Promise<boolean> {
    if (!this.oauthMode || !this.accountId || !usesContainerVaultAuthority()) return super.refreshCredentials();
    const { getOAuthService } = await import('../services/OAuthService');
    return getOAuthService().forceVaultRefresh('grok', this.accountId);
  }

  protected override brokerInjections(): BrokerInjection[] {
    return this.oauthMode
      ? [{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }]
      : super.brokerInjections();
  }

  /**
   * The subscription proxy speaks the Responses API regardless of model
   * name; the metered lane keeps default name-based detection.
   */
  protected override endpointFor(model: string): string {
    // xAI's current X/Web Search tools are supported by the Responses API,
    // not the legacy Chat Completions API. Keep the old metered route when
    // the setting is disabled.
    return this.oauthMode || this.nativeSearchEnabled ? '/responses' : super.endpointFor(model);
  }

  protected override usesResponsesAPIFor(model: string): boolean {
    return this.oauthMode || this.nativeSearchEnabled ? true : super.usesResponsesAPIFor(model);
  }

  /** Merge xAI's remote tools with Sulla function tools without changing their shape. */
  protected override buildRequestBody(messages: ChatMessage[], options: any): any {
    const body = super.buildRequestBody(messages, options);

    if (!this.nativeSearchEnabled || !this.nativeSearchSupported) return body;

    const tools = Array.isArray(body.tools) ? [...body.tools] : [];
    const existingTypes = new Set(tools.map((tool: any) => tool?.type));
    for (const tool of GROK_NATIVE_SEARCH_TOOLS) {
      if (!existingTypes.has(tool.type)) tools.push({ ...tool });
    }
    body.tools = tools;

    return body;
  }

  /**
   * A lane or older model may reject server-side tool declarations. If it
   * does, retry once without them and
   * remember that result for this service instance so ordinary chat survives.
   */
  protected override async sendRawRequest(messages: ChatMessage[], options: any): Promise<any> {
    try {
      return await super.sendRawRequest(messages, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const rejectedTools = this.nativeSearchEnabled && this.nativeSearchSupported &&
        /HTTP (?:400|403|404|422):/i.test(message) &&
        /(?:x_search|web_search|tool|unsupported|unknown)/i.test(message);

      if (!rejectedTools) throw err;

      this.nativeSearchSupported = false;
      console.warn('[GrokService] Grok endpoint rejected native search tools; retrying without them');

      return super.sendRawRequest(messages, options);
    }
  }

  /**
   * Attach the grok-cli identification headers in OAuth mode. Without them
   * the proxy rejects every request with 426.
   */
  protected override buildFetchOptions(body: any, signal?: AbortSignal): RequestInit {
    const options = super.buildFetchOptions(body, signal);

    if (this.oauthMode) {
      options.headers = {
        ...(options.headers as Record<string, string>),
        ...grokCliHeaders(typeof body?.model === 'string' ? body.model : this.model),
      };
    }

    return options;
  }
}

// Factory
let grokInstance: GrokService | null = null;

export async function getGrokService(): Promise<GrokService> {
  if (!grokInstance) {
    grokInstance = await GrokService.create();
  }
  return grokInstance;
}

export function resetGrokService(): void {
  grokInstance = null;
}
