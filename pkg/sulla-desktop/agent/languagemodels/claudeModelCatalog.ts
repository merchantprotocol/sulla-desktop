// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
// is the CLI's own auth pattern, and as of 2026-09-25 Anthropic REJECTS it
// for /v1/models — the endpoint answers 400. The OAuth branch is kept in case
// that changes; a failed live lookup never substitutes hardcoded model ids.

import { usesContainerVaultAuthority } from '../../vault-broker';
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
  name:        'Auto (Claude picks)',
  description: 'Let Claude Code choose the best model automatically',
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; models: ClaudeCatalogModel[] } | null = null;

export function clearClaudeModelCatalogCache(): void {
  cache = null;
}

interface RawAnthropicModel {
  id:            string;
  display_name?: string;
}

async function resolveClaudeCodeCreds(): Promise<{ oauthToken: string; apiKey: string }> {
  let oauthToken = '';
  let apiKey = '';

  try {
    const { getPendingCredential } = await import('../../main/firstRun/pendingCredentials');
    const pending = getPendingCredential('claude-code');
    oauthToken = pending?.values.oauth_token || pending?.values.access_token || '';
    apiKey = pending?.values.api_key || '';
  } catch { /* first-run pending credentials are main-process-only */ }

  if (!oauthToken && !apiKey) try {
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

async function fetchBrokeredModels(): Promise<ClaudeCatalogModel[] | null> {
  try {
    const { listProviderModelsBrokered } = await import('../services/brokeredModelList');
    const { body } = await listProviderModelsBrokered<{ data?: RawAnthropicModel[] }>('claude-code');
    if (!body || !Array.isArray(body.data) || body.data.length === 0) return null;
    const models = body.data
      .filter(m => m && typeof m.id === 'string' && m.id)
      .map(m => ({ id: m.id, name: m.display_name || m.id }));
    return models.length ? models : null;
  } catch {
    return null;
  }
}

/**
 * Return the live Claude model catalog: the "Auto" sentinel followed by
 * every model Anthropic reports for the signed-in claude-code account. Never
 * throws — on any failure (no credential, unauthorized, network) it returns
 * only the provider-agnostic Auto sentinel, never hardcoded model ids.
 *
 * @param opts.force — bypass the short in-memory cache (used by explicit
 *   "refresh models" actions; the picker's routine reads hit the cache).
 */
export async function listClaudeCodeModels(opts?: { force?: boolean }): Promise<ClaudeCatalogModel[]> {
  if (!opts?.force && cache && (Date.now() - cache.at) < CACHE_TTL_MS) {
    return cache.models;
  }

  const pending = await resolveClaudeCodeCreds();
  let dynamic: ClaudeCatalogModel[] | null;
  if (pending.oauthToken || pending.apiKey) {
    dynamic = await fetchLiveModels(pending.oauthToken, pending.apiKey);
  } else if (usesContainerVaultAuthority()) {
    // Container vault: the app holds no Claude credential — list through the
    // vault broker, which attaches the account's key/OAuth token itself.
    dynamic = await fetchBrokeredModels();
  } else {
    dynamic = null;
  }

  const models = [AUTO_SENTINEL, ...(dynamic ?? [])];
  if (dynamic) {
    cache = { at: Date.now(), models };
    log.log(`[claudeModelCatalog] Loaded ${ models.length - 1 } claude models from live catalog`);
  } else {
    log.warn('[claudeModelCatalog] Live model discovery failed — returning Auto only');
  }
  return models;
}
