// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Subscription catalogs come from Claude Code's initialize control response.
// Discovery sends no user prompt or inference request.

import { claudeCredentialResolver } from './credentials/ClaudeCredentialResolver';
import Logging from '@pkg/utils/logging';
import { currentAgentContainerRuntime } from '../services/AgentContainerRuntimeRegistry';
import { fetchClaudeCliModels } from './claudeCliModelDiscovery';
import { AsyncResource } from 'node:async_hooks';

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
 * Null means discovery failed, not that the CLI lacks effort support.
 */
async function claudeEffortLevels(): Promise<{ id: string }[] | null> {
  try {
    const { runCommand } = await import('../tools/util/CommandRunner');
    const { stdout, exitCode } = await runCommand('claude --help', [], { runInGuest: true, timeoutMs: 15_000, maxOutputChars: 200_000 });
    if (exitCode !== 0 || !stdout.trim()) return null;
    const match = /--effort\s+<level>[\s\S]{0,200}?\(([a-z, ]+)\)/.exec(stdout);
    if (!match) return /--effort\b/.test(stdout) ? null : [];
    return match[1].split(',').map(s => s.trim()).filter(s => /^[a-z]{2,10}$/.test(s)).map(id => ({ id }));
  } catch {
    return null;
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
let catalogGeneration = 0;
let catalogFlight: { generation: number; force: boolean; promise: Promise<ClaudeCatalogModel[]> } | undefined;
let mainCatalogResource: AsyncResource | undefined;

/**
 * Install the one metadata-only catalog entry point from the Electron main
 * composition root. AsyncResource preserves the trusted main-process context
 * when a worker asks for catalog metadata, without clearing or bypassing the
 * agent-container AsyncLocalStorage globally.
 */
export function initializeMainClaudeModelCatalogBoundary(): void {
  if (currentAgentContainerRuntime()) throw new Error('Claude catalog boundary must be initialized outside an agent container');
  mainCatalogResource ??= new AsyncResource('SullaMainClaudeModelCatalog');
}

export function clearClaudeModelCatalogCache(): void {
  cache = null;
  catalogGeneration++;
  catalogFlight = undefined;
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
 * initialize control response with the selected subscription account.
 *
 * @param opts.force — bypass the short in-memory cache (used by explicit
 *   "refresh models" actions; the picker's routine reads hit the cache).
 */
export async function listClaudeCodeModels(_opts?: { force?: boolean }): Promise<ClaudeCatalogModel[]> {
  const { sharedModelCatalog } = await import('./sharedModelCatalog');
  return (await sharedModelCatalog.listModels('claude-code')).map(model => ({
    id: model.id, name: model.name,
    ...(model.supportedReasoningEfforts ? { efforts: model.supportedReasoningEfforts.map(id => ({ id })) } : {}),
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
  }));
}

async function loadClaudeCodeModels(opts?: { force?: boolean }): Promise<ClaudeCatalogModel[]> {
  const force = opts?.force === true;
  if (!force && cache && (Date.now() - cache.at) < CACHE_TTL_MS) {
    return cache.models;
  }

  if (catalogFlight?.generation === catalogGeneration && (!force || catalogFlight.force)) return catalogFlight.promise;
  if (force && catalogFlight?.generation === catalogGeneration) {
    // A refresh supersedes an older in-flight read. Its eventual response may
    // reach its original caller, but it cannot repopulate the refreshed cache.
    cache = null;
    catalogGeneration++;
  }
  const generation = catalogGeneration;
  const flight = { generation, force, promise: undefined as unknown as Promise<ClaudeCatalogModel[]> };
  flight.promise = loadClaudeCodeModelsUncached(generation).finally(() => {
    if (catalogFlight === flight) catalogFlight = undefined;
  });
  catalogFlight = flight;
  return flight.promise;
}

async function loadClaudeCodeModelsUncached(generation: number): Promise<ClaudeCatalogModel[]> {
  const credential = await claudeCredentialResolver.resolve();
  let dynamic: ClaudeCatalogModel[] | null;
  if (credential.kind === 'oauth-capability' || credential.kind === 'oauth-pending') {
    dynamic = await fetchClaudeCliModels(credential.accountId ?? undefined);
  } else if (credential.kind === 'api-key' && credential.apiKey) {
    dynamic = await fetchLiveModels(credential.apiKey, credential.workspaceId ?? '');
  } else if (credential.kind === 'api-key' && credential.source === 'vault-broker') {
    dynamic = await fetchBrokeredModels();
  } else {
    dynamic = null;
  }

  let efforts = credential.kind === 'api-key' && dynamic ? await claudeEffortLevels() : [];
  // One bounded, local CLI retry. Never cache an incomplete discovery as unsupported.
  if (dynamic && efforts === null) efforts = await claudeEffortLevels();
  const models = [AUTO_SENTINEL, ...(dynamic ?? []).map(m => (efforts?.length ? { ...m, efforts } : m))];
  if (dynamic) {
    if (efforts !== null && generation === catalogGeneration) cache = { at: Date.now(), models };
    else log.warn('[claudeModelCatalog] Effort discovery unavailable; incomplete catalog is not cached');
    log.log(`[claudeModelCatalog] Loaded ${ models.length - 1 } claude models from live catalog`);
  } else {
    log.warn('[claudeModelCatalog] Live model discovery failed — returning Auto only');
  }
  return models;
}
