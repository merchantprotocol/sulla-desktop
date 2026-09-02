import { type LLMServiceConfig } from './BaseLanguageModel';
import { OpenAICompatibleService } from './OpenAICompatibleService';
import { getIntegrationService } from '../services/IntegrationService';

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
export const GROK_CLI_VERSION = '0.2.91';
export const GROK_CLI_USER_AGENT = `grok-pager/${ GROK_CLI_VERSION } grok-shell/${ GROK_CLI_VERSION } (macos; aarch64)`;

/** Default model on the subscription lane (500k context, Responses backend). */
export const GROK_SUBSCRIPTION_DEFAULT_MODEL = 'grok-4.5';

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
    let apiKey = valMap.api_key || '';
    let oauthMode = false;
    try {
      apiKey = await integrationService.getOAuthAccessToken('grok', 'oauth');
      oauthMode = true;
    } catch { /* not OAuth-connected — fall back to api_key */ }

    let model = valMap.model || '';
    if (oauthMode) {
      // The proxy only serves the subscription catalog. A model saved while
      // on the metered lane (grok-2/grok-3 families) would 404/403 there —
      // coerce to the subscription default instead of failing every call.
      if (!model || /^grok-[23]/.test(model)) {
        if (model) {
          console.log(`[GrokService] Model "${ model }" is not on the subscription lane — using ${ GROK_SUBSCRIPTION_DEFAULT_MODEL }`);
        }
        model = GROK_SUBSCRIPTION_DEFAULT_MODEL;
      }
    }

    return new GrokService({
      id:      'grok',
      model,
      baseUrl: oauthMode ? GROK_SUBSCRIPTION_BASE_URL : GROK_METERED_BASE_URL,
      apiKey,
    }, oauthMode);
  }

  constructor(config: LLMServiceConfig, private readonly oauthMode = false) {
    super(config);
  }

  override getProviderName(): string {
    return 'Grok';
  }

  override getContextWindow(): number {
    return GROK_SUBSCRIPTION_CONTEXT_WINDOWS[this.model] ?? super.getContextWindow();
  }

  /**
   * The subscription proxy speaks the Responses API regardless of model
   * name; the metered lane keeps default name-based detection.
   */
  protected override endpointFor(model: string): string {
    return this.oauthMode ? '/responses' : super.endpointFor(model);
  }

  protected override usesResponsesAPIFor(model: string): boolean {
    return this.oauthMode ? true : super.usesResponsesAPIFor(model);
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
