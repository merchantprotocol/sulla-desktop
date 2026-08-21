// Dynamic Claude Code model catalog.
//
// The claude-code provider previously exposed exactly one model choice —
// "Auto (CLI default)" — because nothing ever queried Anthropic for the real
// list, unlike codexModelCatalog.ts which shells out to `codex debug models`.
// The `claude` CLI has no equivalent list-models subcommand (verified against
// `claude --help` — only `--model <alias-or-id>`, no introspection command),
// so live discovery here goes straight to Anthropic's own live models
// endpoint instead of a CLI wrapper.
//
// Credentials are resolved exactly like ClaudeCodeService.resolveClaudeCreds
// (vault `claude-code` integration, SullaSettingsModel fallback): an API key
// if the user stored one (guaranteed x-api-key auth, same as AnthropicModels
// .ts's live path), otherwise the Claude Code subscription OAuth token via
// Bearer + the `oauth-2025-04-20` beta header. The OAuth header combination
// is the CLI's own auth pattern but has not been independently verified
// against /v1/models in this codebase — if Anthropic rejects it for this
// endpoint, fetchLiveModels degrades to the static safety net below rather
// than throwing.

import Logging from '@pkg/utils/logging';

const log = Logging.background;

export interface ClaudeCatalogModel {
  id:           string;
  name:         string;
  description?: string;
}

/** "Auto" = omit --model so the claude CLI uses its configured default. */
const AUTO_SENTINEL: ClaudeCatalogModel = {
  id:          'claude-code',
  name:        'Auto (CLI default)',
  description: 'Let Claude Code choose the best model automatically',
};

// Safety net only — used when live discovery fails or returns nothing, never
// shown in place of a successful live fetch. IDs are aliases (no date
// suffix) so they self-update on Anthropic's side. Kept in sync with
// AnthropicModels.ts's static fallback for the separate "anthropic" provider.
const STATIC_FALLBACK: ClaudeCatalogModel[] = [
  { id: 'claude-fable-5',  name: 'Claude Fable 5',  description: 'Most capable — long-horizon agentic work' },
  { id: 'claude-opus-5',   name: 'Claude Opus 5',   description: 'Frontier reasoning and complex tasks' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', description: 'Balanced model for everyday work' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Fast and lightweight — background agents' },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; models: ClaudeCatalogModel[] } | null = null;

interface RawAnthropicModel {
  id:            string;
  display_name?: string;
}

async function resolveClaudeCodeCreds(): Promise<{ oauthToken: string; apiKey: string }> {
  let oauthToken = '';
  let apiKey = '';

  try {
    const { getIntegrationService } = await import('../services/IntegrationService');
    const values = await getIntegrationService().getFormValues('claude-code');
    for (const v of values) {
      if (v.property === 'oauth_token' && v.value) oauthToken = v.value;
      if (v.property === 'api_key' && v.value) apiKey = v.value;
    }
  } catch (err) {
    log.warn(`[claudeModelCatalog] Vault lookup failed, trying SullaSettingsModel: ${ err }`);
  }

  if (!oauthToken && !apiKey) {
    try {
      const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
      oauthToken = (await SullaSettingsModel.get('claudeOAuthToken', '')) ?? '';
      apiKey = (await SullaSettingsModel.get('claudeApiKey', '')) ?? '';
    } catch (err) {
      log.warn(`[claudeModelCatalog] SullaSettingsModel lookup failed: ${ err }`);
    }
  }

  return { oauthToken, apiKey };
}

async function fetchModelsWithHeaders(headers: Record<string, string>): Promise<ClaudeCatalogModel[] | null> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models', { headers });

    if (!response.ok) {
      log.warn(`[claudeModelCatalog] /v1/models returned ${ response.status }`);
      return null;
    }

    const body = await response.json() as { data?: RawAnthropicModel[] };

    if (!body.data || body.data.length === 0) return null;

    return body.data.map(m => ({ id: m.id, name: m.display_name || m.id }));
  } catch (err) {
    log.warn(`[claudeModelCatalog] /v1/models fetch failed: ${ err }`);
    return null;
  }
}

async function fetchLiveModels(oauthToken: string, apiKey: string): Promise<ClaudeCatalogModel[] | null> {
  // API key first — same header shape AnthropicModels.ts already uses
  // successfully for the "anthropic" provider, so it's the proven path.
  if (apiKey) {
    const models = await fetchModelsWithHeaders({
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    });
    if (models) return models;
  }

  // Claude Code subscription OAuth — the CLI's own auth pattern.
  if (oauthToken) {
    const models = await fetchModelsWithHeaders({
      Authorization:      `Bearer ${ oauthToken }`,
      'anthropic-beta':   'oauth-2025-04-20',
    });
    if (models) return models;
  }

  return null;
}

/**
 * Return the live Claude model catalog: the "Auto" sentinel followed by
 * every model Anthropic reports for the signed-in claude-code account. Never
 * throws — on any failure (no credential, unauthorized, network) it degrades
 * to Auto + a small static list of current models, so the picker never
 * collapses to a single unusable entry.
 *
 * @param opts.force — bypass the short in-memory cache (used by explicit
 *   "refresh models" actions; the picker's routine reads hit the cache).
 */
export async function listClaudeCodeModels(opts?: { force?: boolean }): Promise<ClaudeCatalogModel[]> {
  if (!opts?.force && cache && (Date.now() - cache.at) < CACHE_TTL_MS) {
    return cache.models;
  }

  const { oauthToken, apiKey } = await resolveClaudeCodeCreds();
  const dynamic = await fetchLiveModels(oauthToken, apiKey);

  const models = [AUTO_SENTINEL, ...(dynamic ?? STATIC_FALLBACK)];
  cache = { at: Date.now(), models };
  log.log(`[claudeModelCatalog] Loaded ${ models.length - 1 } claude models (${ dynamic ? 'live' : 'static fallback' })`);
  return models;
}
