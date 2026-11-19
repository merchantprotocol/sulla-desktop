// SPDX-License-Identifier: GPL-2.0-or-later
import { effectiveEffort, isPairBlocked } from './modelCatalogRules';
import { InfrastructureFailure } from './providerRecovery';

import type { ModelCandidate } from './modelRouter';
import type { RoutingProviderInfo, NeverUsePair } from './modelRoutingTypes';

export interface WorkerModelBinding {
  editToken?: string; agentId: string; revision: number; candidates: ModelCandidate[]; connections?: Record<string, string>;
  /** Written with a pending-migration package mapping until its definition settles; any owner edit drops it. */
  pendingPublication?: { fileId: string; versionId: string };
}
export interface WorkerModelRoute extends WorkerModelBinding { version: 1; slug: string; selected: number; connections?: Record<string, string>; }
export interface WorkerModelInfo { id: string; slug: string; name: string; class: string; runLocation: string; }
export type WorkerModelBindings = Record<string, WorkerModelBinding>;

export function copyWorkerBindings(value: WorkerModelBindings | undefined): WorkerModelBindings {
  return JSON.parse(JSON.stringify(value ?? {}));
}

/** A mapping belongs to an exact definition, not to any future agent reusing its name. */
export function captureWorkerRoute(slug: string, agentId: string, bindings: WorkerModelBindings): WorkerModelRoute | undefined {
  const binding = bindings[slug];
  if (!binding) return undefined;
  if (binding.agentId !== agentId) return undefined;
  return { ...JSON.parse(JSON.stringify(binding)), version: 1, slug, selected: 0 };
}

/** A captured route is waiting for its provider's live catalog, not invalidated by the owner. */
export class WorkerCatalogUnavailable extends InfrastructureFailure {}

/** True when discovery reported at least one verified model, so an absent model is a real catalog change. */
function liveCatalogVerified(provider: RoutingProviderInfo): boolean {
  return provider.models.some(model => !model.unverified && model.id !== provider.id);
}

/** Closed list: never substitute a class/list when every configured candidate is unavailable. */
export function workerRouteCandidates(route: WorkerModelRoute, providers: RoutingProviderInfo[], neverUse: NeverUsePair[]): ModelCandidate[] {
  if (route.version !== 1 || !Array.isArray(route.candidates) || !Number.isInteger(route.selected) || route.selected < 0 || route.selected >= route.candidates.length) throw new Error('Worker model selection is invalid; refusing another route.');
  let waitingForCatalog = false;
  const result = route.candidates.slice(route.selected).filter(candidate => {
    if (!['codex', 'claude-code', 'grok'].includes(candidate.provider)) return false;
    const provider = providers.find(p => p.id === candidate.provider);
    if (!provider) return false;
    const model = provider.models.find(item => item.id === candidate.model);
    // Owner never-use decisions are final even while the catalog is unavailable.
    if (isPairBlocked(neverUse, candidate.provider, candidate.model, effectiveEffort(candidate, provider.models))) return false;
    // A disconnected or empty/unverified live catalog is a provider outage, not an owner change.
    if (!provider.connected || !liveCatalogVerified(provider)) {
      waitingForCatalog = true;
      return false;
    }
    return !!model && (candidate.effort === undefined || !!model.efforts?.some(level => level.id === candidate.effort));
  });
  if (!result.length) {
    if (waitingForCatalog) throw new WorkerCatalogUnavailable('The worker\'s approved subscription model list is temporarily unavailable. Waiting for the provider to report it again.');
    throw new Error('No configured worker model is available. Check its connections and never-use settings in AI Models.');
  }
  return result;
}

export function selectWorkerCandidate(route: WorkerModelRoute, candidate: ModelCandidate): WorkerModelRoute {
  const selected = route.candidates.findIndex((row, index) => index >= route.selected && row.provider === candidate.provider && row.model === candidate.model && row.effort === candidate.effort);
  if (selected < 0) throw new Error('Model is outside the worker launch selection.');
  return { ...route, selected };
}

/** Durable selected configuration, deliberately labelled requested rather than provider attestation. */
export function savedWorkerModelStatus(route?: WorkerModelRoute): import('../../shared/agentState/AgentModelStatus').AgentModelStatusValue | undefined {
  const row = route?.candidates?.[route.selected];
  return row ? { model: row.model, provider: row.provider, effort: row.effort ?? '', source: 'requested', mapping: 'Saved worker mapping' } : undefined;
}
