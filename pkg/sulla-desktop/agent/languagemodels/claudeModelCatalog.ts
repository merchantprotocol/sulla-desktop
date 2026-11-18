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

import { claudeCredentialResolver } from './credentials/ClaudeCredentialResolver';
import Logging from '@pkg/utils/logging';

const log = Logging.background;

export interface ClaudeCatalogModel {
  id:           string;
  name:         string;
  description?: string;
  efforts?:     { id: string }[];
  /** True for the fixed list used when Anthropic offers no model list (subscription sign-in). */
  unverified?:  boolean;
}

/**
 * Effort levels the installed Claude Code accepts, read from its own `--help`
 * ("--effort <level> … (low, medium, high, xhigh, max)"). Empty when the CLI
 * has no such option, so the page then shows no effort choice for Claude.
 */
async function claudeEffortLevels(): Promise<{ id: string }[]> {
  try {
    const { runCommand } = await import('../tools/util/CommandRunner');
    const { stdout, exitCode } = await runCommand('claude --help', [], { runInGuest: true, timeoutMs: 15_000, maxOutputChars: 200_000 });
    if (exitCode !== 0) return [];
    const match = /--effort\s+<level>[\s\S]{0,200}?\(([a-z, ]+)\)/.exec(stdout);
    return match ? match[1].split(',').map(s => s.trim()).filter(s => /^[a-z]{2,10}$/.test(s)).map(id => ({ id })) : [];
  } catch {
    return [];
  }
}

/** "Auto" = omit --model so the claude CLI uses its configured default. */
const AUTO_SENTINEL: ClaudeCatalogModel = {
  id:          'claude-code',
  name:        'Auto (Claude picks)',
  description: 'Let Claude Code choose the best model automatically',
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; models: ClaudeCatalogModel[] } | null = null;
let inFlight: Promise<ClaudeCatalogModel[]> | null = null;

export function clearClaudeModelCatalogCache(): void {
  cache = null;
}

interface RawAnthropicModel {
  id:            string;
  display_name?: string;
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

async function fetchLiveModels(apiKey: string, workspaceId: string): Promise<ClaudeCatalogModel[] | null> {
  // API key first — same header shape AnthropicModels.ts already uses
  // successfully for the "anthropic" provider, so it's the proven path.
  if (apiKey) {
    const models = await fetchModelsWithHeaders({
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
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
 * only the provider-agnostic Auto sentinel. OAuth accounts use the CLI's
 * supported static aliases because Anthropic rejects their token on /v1/models.
 *
 * @param opts.force — bypass the short in-memory cache (used by explicit
 *   "refresh models" actions; the picker's routine reads hit the cache).
 */
export async function listClaudeCodeModels(opts?: { force?: boolean }): Promise<ClaudeCatalogModel[]> {
  if (!opts?.force && cache && (Date.now() - cache.at) < CACHE_TTL_MS) {
    return cache.models;
  }
  if (inFlight) return inFlight;
  inFlight = loadClaudeCodeModels().finally(() => { inFlight = null; });
  return inFlight;
}

async function loadClaudeCodeModels(): Promise<ClaudeCatalogModel[]> {

  const credential = await claudeCredentialResolver.resolve();
  let dynamic: ClaudeCatalogModel[] | null;
  if (credential.kind === 'oauth-capability' || credential.kind === 'oauth-pending') {
    // Anthropic rejects Claude subscription OAuth on /v1/models. Keep the
    // supported CLI aliases stable instead of making a request known to fail.
    // The aliases are Claude Code's own "newest in this family" names, so they stay current without edits here.
    dynamic = [
      { id: 'opus', name: 'Newest Opus', description: 'Claude Code picks the latest Opus', unverified: true },
      { id: 'sonnet', name: 'Newest Sonnet', description: 'Claude Code picks the latest Sonnet', unverified: true },
      { id: 'haiku', name: 'Newest Haiku', description: 'Claude Code picks the latest Haiku', unverified: true },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', unverified: true },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', unverified: true },
      { id: 'claude-opus-5', name: 'Claude Opus 5', unverified: true },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', unverified: true },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', unverified: true },
    ];
  } else if (credential.kind === 'api-key' && credential.apiKey) {
    dynamic = await fetchLiveModels(credential.apiKey, credential.workspaceId ?? '');
  } else if (credential.kind === 'api-key' && credential.source === 'vault-broker') {
    dynamic = await fetchBrokeredModels();
  } else {
    dynamic = null;
  }

  const efforts = dynamic ? await claudeEffortLevels() : [];
  const models = [AUTO_SENTINEL, ...(dynamic ?? []).map(m => (efforts.length ? { ...m, efforts } : m))];
  if (dynamic) {
    cache = { at: Date.now(), models };
    log.log(`[claudeModelCatalog] Loaded ${ models.length - 1 } claude models from live catalog`);
  } else {
    log.warn('[claudeModelCatalog] Live model discovery failed — returning Auto only');
  }
  return models;
}
