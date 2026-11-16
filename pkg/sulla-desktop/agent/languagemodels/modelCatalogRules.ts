// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Provider-neutral model rules, the never-use list and live-list comparisons.
 * Nothing here knows a provider's model names: rules read whatever list the
 * provider's integration reports, in the provider's own order.
 */

import { MODEL_CLASSES, type ClassModel, type ModelCatalogReport, type ModelClass, type ModelRule, type NeverUsePair } from './modelRoutingTypes';

export interface LiveModel { id: string; label?: string; unverified?: boolean; defaultEffort?: string }

/** A list Sulla can check models against: the provider reported it, rather than a fixed fallback list. */
export function isLiveList(models: readonly LiveModel[]): boolean {
  return models.some(m => !m.unverified && !/^auto$/i.test(m.id));
}

/** "Auto" entries (the CLI picks for itself) are modes, not models; rules never pick them. */
export function isAutoEntry(provider: string, id: string): boolean {
  return id === provider || /^auto$/i.test(id);
}

export function blockedKey(provider: string, model: string): string { return `${ provider }/${ model }` }

/** The model is never used at any effort. */
export function isBlocked(neverUse: readonly NeverUsePair[], provider: string, model: string): boolean {
  return neverUse.some(b => b.provider === provider && b.model === model && b.effort === 'any');
}

/** This model at this effort is a never-use pair. `effort` is the level the run would use; '' when unknown. */
export function isPairBlocked(neverUse: readonly NeverUsePair[], provider: string, model: string, effort: string): boolean {
  return neverUse.some(b => b.provider === provider && b.model === model && (b.effort === 'any' || (!!effort && b.effort === effort)));
}

/** The effort a role entry runs at: its own level, or the model's default when the provider reports one. */
export function effectiveEffort(item: Pick<ClassModel, 'effort' | 'model'>, models: readonly { id: string; defaultEffort?: string }[]): string {
  return item.effort || models.find(m => m.id === item.model)?.defaultEffort || '';
}

/** The model a rule picks from a provider's live list, or null when nothing matches. */
export function resolveRule(rule: ModelRule, provider: string, models: readonly LiveModel[], blocked: readonly NeverUsePair[]): string | null {
  const usable = models.filter(m => !isAutoEntry(provider, m.id) && !isBlocked(blocked, provider, m.id));
  if (rule.kind === 'first') return usable[0]?.id ?? null;
  const text = rule.text.trim().toLowerCase();
  if (!text) return null;
  return usable.find(m => m.id.toLowerCase().includes(text) || (m.label ?? '').toLowerCase().includes(text))?.id ?? null;
}

export function ruleLabel(rule: ModelRule): string {
  return rule.kind === 'first' ? 'First model in the list' : `Name contains "${ rule.text }"`;
}

/**
 * Re-resolve every rule entry against the live lists. Providers with no list keep their last pick,
 * and a rule with no match keeps its last pick too, so a flaky catalog never empties a role.
 */
export function applyRules(
  classes: Record<ModelClass, ClassModel[]>,
  live: ReadonlyMap<string, readonly LiveModel[]>,
  blocked: readonly NeverUsePair[],
): { classes: Record<ModelClass, ClassModel[]>; moved: ModelCatalogReport['moved'] } {
  const moved: ModelCatalogReport['moved'] = [];
  const out = {} as Record<ModelClass, ClassModel[]>;
  for (const cls of MODEL_CLASSES) {
    out[cls] = (classes[cls] || []).map(item => {
      if (!item.rule) return item;
      const models = live.get(item.provider);
      if (!models?.length) return item;
      const pick = resolveRule(item.rule, item.provider, models, blocked);
      if (!pick || pick === item.model) return item;
      moved.push({ class: cls, provider: item.provider, from: item.model, to: pick });
      return { ...item, model: pick };
    });
  }
  return { classes: out, moved };
}

/** Models added and removed between two checks, per provider. Providers missing from either side are not compared. */
export function compareCatalogs(previous: Readonly<Record<string, readonly string[]>>, next: Readonly<Record<string, readonly string[]>>): Pick<ModelCatalogReport, 'added' | 'removed'> {
  const added: ClassModel[] = []; const removed: ClassModel[] = [];
  for (const [provider, ids] of Object.entries(next)) {
    const before = previous[provider];
    if (!before?.length || !ids.length) continue;
    for (const id of ids) if (!before.includes(id) && !isAutoEntry(provider, id)) added.push({ provider, model: id });
    for (const id of before) if (!ids.includes(id) && !isAutoEntry(provider, id)) removed.push({ provider, model: id });
  }
  return { added, removed };
}

/** A saved model missing from the provider's current list (it may be retired, or the list may omit it). Unknown when the provider reports no list. */
export function isUnlisted(item: ClassModel, models: readonly LiveModel[]): boolean {
  return isLiveList(models.filter(m => !isAutoEntry(item.provider, m.id))) && !isAutoEntry(item.provider, item.model) && !models.some(m => m.id === item.model);
}
