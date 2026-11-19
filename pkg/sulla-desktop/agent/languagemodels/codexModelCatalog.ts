// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Dynamic OpenAI Codex model catalog.
//
// The catalog is fetched through the existing vault-broker provider.models
// operation. The broker injects the connected ChatGPT subscription token and
// account routing header inside the vault boundary; this module receives only
// the provider's JSON metadata. The legacy VM `codex debug models` route is
// deliberately not used because it can include internal prompt material.

import Logging from '@pkg/utils/logging';

const log = Logging.background;

export interface CodexCatalogModel {
  id:             string;
  name:           string;
  description?:   string;
  efforts?:       { id: string; description?: string }[];
  defaultEffort?: string;
  upgrade?:       string;
}

/** "Auto" = omit --model so the codex CLI uses its configured default. */
const AUTO_SENTINEL: CodexCatalogModel = {
  id:          'codex',
  name:        'Auto (CLI default)',
  description: 'Let Codex choose the best model automatically',
};

let catalogGeneration = 0;
let catalogFlight: { generation: number; force: boolean; promise: Promise<CodexCatalogModel[]> } | undefined;
let lastDiscoveryFailure: string | undefined;

export function getLastCodexModelCatalogFailure(): string | undefined { return lastDiscoveryFailure; }

export function clearCodexModelCatalogCache(): void {
  catalogGeneration++;
  catalogFlight = undefined;
}

interface RawCodexModel {
  slug?:                       string;
  display_name?:               string;
  description?:                string;
  visibility?:                 string;
  supported_reasoning_levels?: { effort?: string; description?: string }[];
  default_reasoning_level?:    string;
  upgrade?:                    { model?: string } | null;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EFFORT_ID = /^[a-z][a-z0-9_-]{1,15}$/;
const CODEX_CLIENT_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = Array.from(value).filter(character => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  }).join('').trim().slice(0, maxLength);
  return text || undefined;
}

function safeModelId(value: unknown): string | undefined {
  return typeof value === 'string' && MODEL_ID.test(value) ? value : undefined;
}

function mapCodexModel(raw: RawCodexModel): CodexCatalogModel | null {
  if (raw.visibility !== 'list') return null;
  const id = safeModelId(raw.slug);
  if (!id || id === AUTO_SENTINEL.id) return null;

  const efforts = Array.isArray(raw.supported_reasoning_levels)
    ? raw.supported_reasoning_levels.reduce<{ id: string; description?: string }[]>((result, level) => {
      const effort = typeof level === 'object' && level ? safeText(level.effort, 16) : undefined;
      if (!effort || !EFFORT_ID.test(effort) || result.some(item => item.id === effort)) return result;
      const description = typeof level === 'object' && level ? safeText(level.description, 256) : undefined;
      result.push({ id: effort, ...(description ? { description } : {}) });
      return result;
    }, [])
    : [];
  const defaultEffort = safeText(raw.default_reasoning_level, 16);
  const description = safeText(raw.description, 512);
  const upgrade = safeModelId(raw.upgrade?.model);
  return {
    id,
    name: safeText(raw.display_name, 160) ?? id,
    ...(description ? { description } : {}),
    ...(efforts.length ? { efforts } : {}),
    ...(defaultEffort && efforts.some(effort => effort.id === defaultEffort) ? { defaultEffort } : {}),
    ...(upgrade ? { upgrade } : {}),
  };
}

function dynamicModels(body: unknown): CodexCatalogModel[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const rawModels = (body as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) return [];
  const seen = new Set<string>();
  const models: CodexCatalogModel[] = [];
  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const model = mapCodexModel(raw as RawCodexModel);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

async function selectedCodexClientVersion(): Promise<string> {
  const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
  const selected = await SullaSettingsModel.get('approvedProviderCliVersions', {}) as unknown;
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    throw new Error('Saved provider CLI selections are invalid; refusing an image-default catalog request.');
  }

  const value = (selected as Record<string, unknown>).codex;
  if (value !== undefined && value !== null) {
    if (typeof value !== 'string' || !CODEX_CLIENT_VERSION.test(value)) {
      throw new Error('Saved Codex CLI selection is invalid; refusing a catalog request.');
    }
    return value;
  }

  // Image-default selection must describe the actual worker binary. The VM helper
  // can be a different platform/version and is never a catalog identity source.
  const { getWorkerImageCliVersion } = await import('@pkg/backend/providerCliUpdates');
  const imageVersion = await getWorkerImageCliVersion('codex');
  if (!imageVersion || !CODEX_CLIENT_VERSION.test(imageVersion)) {
    throw new Error('The actual worker image Codex version is unavailable; refusing a catalog request.');
  }
  return imageVersion;
}

async function fetchBrokeredModels(force: boolean): Promise<CodexCatalogModel[] | null> {
  try {
    const brokered = await import('../services/brokeredModelList');
    if (force) brokered.clearBrokeredModelListCache();
    const clientVersion = await selectedCodexClientVersion();
    const { body } = await brokered.listProviderModelsBrokered<{ models?: unknown }>('codex', undefined, undefined, lane => {
      const url = new URL(lane.url);
      url.searchParams.set('client_version', clientVersion);
      return url.toString();
    });
    const models = dynamicModels(body);
    lastDiscoveryFailure = models.length ? undefined : 'Codex returned no selectable models';
    return models.length ? models : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    lastDiscoveryFailure = /version is unavailable|selection is invalid/i.test(message)
      ? 'Codex CLI version unavailable or invalid'
      : /(?:401|unauthorized|authentication)/i.test(message)
        ? 'Codex account authentication failed'
        : /timeout|timed out|abort/i.test(message)
          ? 'Codex model request timed out'
          : 'Codex live model discovery failed';
    return null;
  }
}

/**
 * Return the live Codex model catalog: the Auto sentinel followed by every
 * selectable model reported by the connected ChatGPT account. A failed or
 * empty response returns Auto only and is never cached as a successful list.
 */
export async function listCodexModels(opts?: { force?: boolean }): Promise<CodexCatalogModel[]> {
  const force = opts?.force === true;
  if (catalogFlight?.generation === catalogGeneration && (!force || catalogFlight.force)) return catalogFlight.promise;
  if (force && catalogFlight?.generation === catalogGeneration) {
    catalogGeneration++;
  }

  const generation = catalogGeneration;
  const flight = { generation, force, promise: undefined as unknown as Promise<CodexCatalogModel[]> };
  flight.promise = (async() => {
    const dynamic = await fetchBrokeredModels(force);
    if (!dynamic) {
      log.warn('[codexModelCatalog] Live model discovery failed or returned no selectable metadata; returning Auto only');
      return [AUTO_SENTINEL];
    }
    const models = [AUTO_SENTINEL, ...dynamic];
    log.log(`[codexModelCatalog] Loaded ${ dynamic.length } visible codex models from the connected account`);
    return models;
  })().finally(() => {
    if (catalogFlight === flight) catalogFlight = undefined;
  });
  catalogFlight = flight;
  return flight.promise;
}
