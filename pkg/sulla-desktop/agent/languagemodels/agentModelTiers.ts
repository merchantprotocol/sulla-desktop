// SPDX-License-Identifier: GPL-2.0-or-later

import { workflowCompany } from '../../shared/productOwnerWorkflow';
import { effectiveEffort, isPairBlocked } from './modelCatalogRules';

import type { ModelCandidate } from './modelRouter';
import { MODEL_CLASSES, type ModelClass, type NeverUsePair, type RoutingProviderInfo } from './modelRoutingTypes';

export interface ModelTier { candidates: ModelCandidate[]; pick?: 'first' }
export interface AgentModelTiers {
  version: 1;
  tiers: ModelTier[];
  crossCompanyFallback?: boolean;
  allowLaunchOverride?: 'never' | 'listed' | 'any';
  preset?: ModelClass;
}

export interface TierCandidate { candidate: ModelCandidate; tier: number }
export interface TierSkip extends TierCandidate { reason: string; transient?: boolean }

export function candidateKey(candidate: ModelCandidate): string {
  return JSON.stringify([candidate.provider, candidate.model, candidate.effort ?? null]);
}

export function formatModelCandidate(candidate: ModelCandidate): string {
  return `${ candidate.provider }/${ candidate.model }${ candidate.effort ? ` (${ candidate.effort })` : '' }`;
}

/** The legacy order becomes one entry per tier. Selection still uses the legacy router until saved as tiers. */
export function tiersFromCandidates(candidates: ModelCandidate[], preset?: ModelClass): AgentModelTiers | undefined {
  if (!candidates.length) return undefined;
  return { version: 1, tiers: candidates.map(candidate => ({ candidates: [{ ...candidate }] })), ...(preset ? { preset } : {}) };
}

export function cleanAgentModelTiers(value: unknown): AgentModelTiers {
  const config = value as Partial<AgentModelTiers> | null;
  if (config?.version !== 1 || !Array.isArray(config.tiers) || !config.tiers.length || config.tiers.length > 10) {
    throw new Error('Choose one to ten model tiers.');
  }
  if (config.crossCompanyFallback !== undefined && typeof config.crossCompanyFallback !== 'boolean') throw new Error('Invalid cross-company fallback setting.');
  if (config.allowLaunchOverride !== undefined && !['never', 'listed', 'any'].includes(config.allowLaunchOverride)) throw new Error('Invalid launch override policy.');
  if (config.preset !== undefined && !MODEL_CLASSES.includes(config.preset)) throw new Error('Unknown model preset.');
  const seen = new Set<string>();
  const tiers = config.tiers.map((tier, tierIndex) => {
    if (!Array.isArray(tier?.candidates) || !tier.candidates.length || tier.candidates.length > 10 || (tier.pick !== undefined && tier.pick !== 'first')) {
      throw new Error(`Tier ${ tierIndex + 1 }: choose one to ten models in priority order.`);
    }
    const candidates = tier.candidates.map((candidate, rowIndex) => {
      const label = `Tier ${ tierIndex + 1 }, model ${ rowIndex + 1 }`;
      if (typeof candidate?.provider !== 'string' || !candidate.provider.trim() || typeof candidate.model !== 'string' || !candidate.model.trim() ||
          (candidate.effort !== undefined && (typeof candidate.effort !== 'string' || !/^[a-z]{2,10}$/.test(candidate.effort)))) {
        throw new Error(`${ label }: choose a valid provider, model and effort.`);
      }
      const row = { provider: candidate.provider.trim(), model: candidate.model.trim(), ...(candidate.effort !== undefined ? { effort: candidate.effort } : {}) };
      const key = candidateKey(row);
      if (seen.has(key)) throw new Error(`${ label }: this provider, model and effort already appears in the tiers.`);
      seen.add(key);
      return row;
    });
    return { candidates, ...(tier.pick ? { pick: tier.pick } : {}) };
  });
  return { version: 1, tiers, crossCompanyFallback: config.crossCompanyFallback ?? true, allowLaunchOverride: config.allowLaunchOverride ?? 'listed', ...(config.preset ? { preset: config.preset } : {}) };
}

export function tierEntries(config: AgentModelTiers): TierCandidate[] {
  return config.tiers.flatMap((tier, index) => tier.candidates.map(candidate => ({ candidate, tier: index + 1 })));
}

export function staysWithPrimaryCompany(config: AgentModelTiers, candidate: ModelCandidate): boolean {
  const primary = workflowCompany(config.tiers[0].candidates[0].provider);
  return config.crossCompanyFallback !== false || (!!primary && primary === workflowCompany(candidate.provider));
}

export function orderTierEntries(config: AgentModelTiers, backedOff: ReadonlySet<string>): TierCandidate[] {
  return tierEntries(config).sort((a, b) => Number(backedOff.has(a.candidate.provider)) - Number(backedOff.has(b.candidate.provider)) || a.tier - b.tier);
}

/** Filter a captured order without reordering after a job has advanced past a candidate. */
export function resolveTierEntries(config: AgentModelTiers, entries: TierCandidate[], providers: RoutingProviderInfo[], neverUse: NeverUsePair[]): { available: TierCandidate[]; skipped: TierSkip[] } {
  const available: TierCandidate[] = [];
  const skipped: TierSkip[] = [];
  const byProvider = new Map(providers.map(provider => [provider.id, provider]));
  for (const entry of entries) {
    const { candidate } = entry;
    const provider = byProvider.get(candidate.provider);
    const catalog = provider?.models ?? [];
    const model = catalog.find(row => row.id === candidate.model && !row.unverified);
    if (!staysWithPrimaryCompany(config, candidate)) skipped.push({ ...entry, reason: 'different company from Tier 1' });
    else if (isPairBlocked(neverUse, candidate.provider, candidate.model, effectiveEffort(candidate, catalog))) skipped.push({ ...entry, reason: 'blocked by Never-use' });
    else if (!provider) skipped.push({ ...entry, reason: 'provider is unavailable' });
    else if (!provider.connected) skipped.push({ ...entry, reason: 'provider is disconnected', transient: true });
    else if (!model && !catalog.some(row => !row.unverified && row.id !== provider.id)) skipped.push({ ...entry, reason: 'live model catalog is unavailable', transient: true });
    else if (!model) skipped.push({ ...entry, reason: 'model is absent from the verified catalog' });
    else if (candidate.effort !== undefined && !model.efforts?.some(row => row.id === candidate.effort)) skipped.push({ ...entry, reason: 'effort is unavailable' });
    else available.push(entry);
  }
  return { available, skipped };
}

export function exactTierRequest(slug: string, config: AgentModelTiers, entries: TierCandidate[], requested: ModelCandidate) {
  const policy = config.allowLaunchOverride ?? 'listed';
  if (policy === 'never') throw new Error(`${ slug } doesn't accept launch-time model choices.`);
  const match = entries.find(({ candidate }) => candidate.provider === requested.provider && candidate.model === requested.model &&
    (requested.effort === undefined || requested.effort === candidate.effort));
  if (!match && policy === 'listed') throw new Error(`${ slug } doesn't list ${ formatModelCandidate(requested) }. Add it to the agent's tiers or omit the model.`);
  const first = match ?? { candidate: requested, tier: 0 };
  if (!staysWithPrimaryCompany(config, first.candidate)) throw new Error(`${ slug } stays with Tier 1's company. Choose another model or omit the model.`);
  return first;
}
