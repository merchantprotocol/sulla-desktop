// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Role lanes (Preferences → AI models): where each chip's model came from, whether it still exists, and who uses a role. */

import { findProvider, modelKey } from './routingLogic';

import { effectiveEffort, isAutoEntry, isBlocked, isLiveList, isPairBlocked, isUnlisted, ruleLabel } from '@pkg/agent/languagemodels/modelCatalogRules';
import { MODEL_CLASSES, type ClassModel, type ModelClass, type ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';

export type Provenance = 'rule' | 'chosen' | 'default' | 'earlier';
export type ChipHealth = 'ok' | 'unlisted' | 'unverified' | 'blocked' | 'offline';

export function provenance(state: Pick<ModelRoutingState, 'recommended'>, cls: ModelClass, item: ClassModel): Provenance {
  if (item.rule) return 'rule';
  if (item.chosen) return 'chosen';
  return state.recommended?.classes[cls]?.some(r => r.provider === item.provider && r.model === item.model) ? 'default' : 'earlier';
}

export function provenanceText(state: Pick<ModelRoutingState, 'recommended'>, cls: ModelClass, item: ClassModel): string {
  switch (provenance(state, cls, item)) {
  case 'rule': return ruleLabel(item.rule!);
  case 'chosen': return 'You chose';
  case 'default': return 'Sulla default';
  default: return 'Saved earlier';
  }
}

export function chipHealth(state: Pick<ModelRoutingState, 'providers' | 'neverUse'>, item: ClassModel): ChipHealth {
  const provider = findProvider(state, item.provider);
  if (!provider?.connected) return 'offline';
  if (isPairBlocked(state.neverUse ?? [], item.provider, item.model, effectiveEffort(item, provider.models))) return 'blocked';
  if (!isLiveList(provider.models.filter(m => !isAutoEntry(item.provider, m.id)))) return 'unverified';
  return isUnlisted(item, provider.models) ? 'unlisted' : 'ok';
}

/** Roles shown as lanes: Local only while a local provider is connected. */
export function visibleRoles(state: Pick<ModelRoutingState, 'providers'>): ModelClass[] {
  return MODEL_CLASSES.filter(c => c !== 'local' || state.providers.some(p => p.local && p.connected));
}

/** Who uses a role: the main and background lists (when a row asks for it) and agents set to the class. */
export function usedBy(state: Pick<ModelRoutingState, 'agentsList' | 'subconsciousList' | 'classUsers'>, cls: ModelClass): string[] {
  const out: string[] = [];
  if (state.agentsList.some(r => r.enabled && r.class === cls)) out.push('Main agents');
  if (state.subconsciousList.some(r => r.enabled && r.class === cls)) out.push('Background agents');
  return [...out, ...(state.classUsers?.[cls] ?? [])];
}

/** Connected providers not yet in a role, in the page's provider order. */
export function addableProviders(state: ModelRoutingState, cls: ModelClass, lane: readonly ClassModel[]): string[] {
  return state.providers.filter(p => p.connected && (cls !== 'local' || p.local) && !lane.some(m => m.provider === p.id)).map(p => p.id);
}

/** The model a new chip starts on: the provider's first real model, never on the never-use list. */
export function firstUsableModel(state: Pick<ModelRoutingState, 'providers' | 'neverUse'>, provider: string): string {
  const models = findProvider(state, provider)?.models ?? [];
  return models.find(m => !isAutoEntry(provider, m.id) && !isBlocked(state.neverUse ?? [], provider, m.id))?.id ?? '';
}

function itemKey(m: ClassModel): string { return `${ modelKey(m) }|${ m.rule ? JSON.stringify(m.rule) : '' }|${ m.effort ?? '' }` }

/** True when a chip differs from the saved lane at the same position. */
export function chipChanged(saved: readonly ClassModel[], draft: readonly ClassModel[], index: number): boolean {
  const a = saved[index]; const b = draft[index];
  return !a || !b || itemKey(a) !== itemKey(b);
}

export function laneChanged(saved: readonly ClassModel[], draft: readonly ClassModel[]): boolean {
  return saved.length !== draft.length || draft.some((_, i) => chipChanged(saved, draft, i));
}

export function isNewModel(state: Pick<ModelRoutingState, 'catalog'>, provider: string, model: string): boolean {
  return !!state.catalog?.added.some(a => a.provider === provider && a.model === model);
}

/** Effort levels the chosen model accepts, as its provider reports them; empty when the provider reports none. */
export function effortLevels(state: Pick<ModelRoutingState, 'providers'>, item: ClassModel): { id: string; description?: string }[] {
  return findProvider(state, item.provider)?.models.find(m => m.id === item.model)?.efforts ?? [];
}

export function defaultEffort(state: Pick<ModelRoutingState, 'providers'>, item: ClassModel): string | undefined {
  return findProvider(state, item.provider)?.models.find(m => m.id === item.model)?.defaultEffort;
}

/** This model at this effort level is a never-use pair. */
export function isLevelBlocked(state: Pick<ModelRoutingState, 'neverUse'>, provider: string, model: string, effort: string): boolean {
  return isPairBlocked(state.neverUse ?? [], provider, model, effort);
}

/** A saved effort the model no longer accepts. */
export function effortUnsupported(state: Pick<ModelRoutingState, 'providers'>, item: ClassModel): boolean {
  const levels = effortLevels(state, item);
  return !!item.effort && levels.length > 0 && !levels.some(l => l.id === item.effort);
}

/** The model the provider recommends instead, when it is in the list and usable. */
export function upgradeFor(state: Pick<ModelRoutingState, 'providers' | 'neverUse'>, item: ClassModel): string | undefined {
  const models = findProvider(state, item.provider)?.models ?? [];
  const next = models.find(m => m.id === item.model)?.upgrade;
  return next && models.some(m => m.id === next) && !isBlocked(state.neverUse ?? [], item.provider, next) ? next : undefined;
}

export const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra', minimal: 'Minimal', none: 'None' };
export function effortLabel(id: string): string { return EFFORT_LABELS[id] ?? id }
