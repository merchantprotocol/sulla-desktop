// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * ModelTierResolver
 *
 * Classifies LLM models into capability tiers by name pattern and resolves
 * a tier name to the best available model ID for a given provider at runtime.
 *
 * Tier names ('fast' | 'balanced' | 'powerful') can be stored in settings
 * instead of hard-coded version strings so the system auto-selects the best
 * model as providers retire or release new versions.
 */

import { modelDiscoveryService } from './ModelDiscoveryService';
import { isModelRoutingAlias } from './modelSlotRouting';
import { usesContainerVaultAuthority } from '../../vault-broker';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { getIntegrationService } from '../services/IntegrationService';

export type ModelTier = 'fast' | 'balanced' | 'powerful';

const MODEL_TIERS = new Set<string>(['fast', 'balanced', 'powerful']);

export function isTierName(s: string | undefined | null): s is ModelTier {
  return !!s && MODEL_TIERS.has(s);
}

// Classification rules — applied in order, first match wins.
// Patterns intentionally broad so they survive version/date changes.
const TIER_PATTERNS: Record<ModelTier, RegExp[]> = {
  fast: [
    /haiku/i,
    /\bmini\b/i,
    /\bflash\b/i,
    /\bnano\b/i,
    /\blite\b/i,
    /\bsmall\b/i,
    /instant/i,
  ],
  balanced: [
    /sonnet/i,
    /\bturbo\b/i,
    /\bplus\b/i,
    /\bmedium\b/i,
  ],
  powerful: [
    /opus/i,
    /\blarge\b/i,
    /ultra/i,
    /\bpro\b/i,
    /\bmax\b/i,
    /premier/i,
    /heavy/i,
  ],
};

export function classifyModelTier(modelId: string): ModelTier | null {
  for (const [tier, patterns] of Object.entries(TIER_PATTERNS) as [ModelTier, RegExp[]][]) {
    if (patterns.some(p => p.test(modelId))) return tier;
  }
  return null;
}

// Prefer aliases without trailing date suffix — they track latest automatically.
// e.g. "claude-sonnet-4-6" beats "claude-sonnet-4-6-20250514".
// Among dated models, pick the lexicographically largest (most recent).
function selectBestForTier(modelIds: string[], tier: ModelTier): string | undefined {
  const candidates = modelIds.filter(id => classifyModelTier(id) === tier);
  if (!candidates.length) return undefined;

  const undated = candidates.filter(id => !/\d{8}$/.test(id));
  const pool = undated.length ? undated : candidates;
  return pool.sort((a, b) => b.localeCompare(a))[0];
}

async function getApiKeyForProvider(providerId: string): Promise<string> {
  if (providerId === 'claude-code') {
    const oauth = await SullaSettingsModel.get('claudeOAuthToken', '');
    const apiKey = await SullaSettingsModel.get('claudeApiKey', '');
    return oauth || apiKey;
  }
  try {
    const svc = getIntegrationService();
    const values = await svc.getFormValues(providerId);
    return values.find(v => v.property === 'api_key')?.value || '';
  } catch {
    return '';
  }
}

// CLI providers pick their own default model, which is their heaviest one.
// An agent that explicitly declares the 'fast' tier (the voice agent) gets the
// provider's light model instead. Same ids the built-in Haiku and Codex Luna
// workers already run on.
const CLI_FAST_MODELS: Record<string, string> = {
  'claude-code': 'claude-haiku-5-5',
  codex:         'gpt-5.6-luna',
};

/**
 * Light model for a CLI provider when an agent asks for the 'fast' tier by
 * name. Undefined for other tiers and providers (the CLI picks its default).
 * Deliberately NOT applied inside resolveTierToModelId: the subconscious and
 * heartbeat slots default to 'fast' too, and they keep their current model.
 */
export function cliTierModelId(providerId: string, tier: ModelTier): string | undefined {
  return tier === 'fast' ? CLI_FAST_MODELS[providerId] : undefined;
}

/**
 * The model id a CLI provider's bridge pins for an agent's configured model.
 * A tier the CLI resolves itself ('fast' → the light model) pins that resolved
 * id; other slot/tier aliases pin nothing, since the CLI picks its default.
 */
export function cliPinnedModelId(providerId: string, model: string | null | undefined): string | undefined {
  const value = model?.trim();
  if (!value || value === providerId) return undefined;
  const alias = value.toLowerCase();
  if (isTierName(alias)) return cliTierModelId(providerId, alias);

  return isModelRoutingAlias(alias) ? undefined : value;
}

/**
 * Resolves a tier name to the best available model ID for a provider.
 *
 * - Fetches live model list from the provider API (cached 30 min).
 * - Classifies each model by name pattern.
 * - Returns the best-matched model ID, or undefined on failure.
 *
 * Callers should treat undefined as "let the provider pick its own default"
 * (i.e. omit the --model flag entirely).
 */
export async function resolveTierToModelId(
  providerId: string,
  tier: ModelTier,
): Promise<string | undefined> {
  // claude-code / codex delegate model selection to the CLI — never override
  if (providerId === 'claude-code' || providerId === 'codex' || providerId === 'opencode' || providerId === 'cursor') return undefined;

  try {
    const containerAuthority = usesContainerVaultAuthority();
    const apiKey = containerAuthority ? '' : await getApiKeyForProvider(providerId);
    if (!containerAuthority && !apiKey) return undefined;

    const models = await modelDiscoveryService.fetchModelsForProvider(providerId, apiKey);
    const modelIds = models.map(m => m.id);
    const resolved = selectBestForTier(modelIds, tier);

    if (resolved) {
      console.log(`[ModelTierResolver] ${ providerId }/${ tier } → ${ resolved }`);
    } else {
      console.warn(`[ModelTierResolver] No '${ tier }' model found for ${ providerId } (${ modelIds.length } available)`);
    }

    return resolved;
  } catch (err) {
    console.warn(`[ModelTierResolver] Failed to resolve ${ providerId }/${ tier }:`, err);
    return undefined;
  }
}
