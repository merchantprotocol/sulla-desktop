// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { effortLabel } from './laneLogic';
import { CLASS_LABELS, modelName, providerName } from './routingLogic';

import type { ClassModel, ModelClass, ModelRoutingState, NeverUsePair } from '@pkg/agent/languagemodels/modelRoutingTypes';

type Lanes = Record<ModelClass, ClassModel[]>;

const SHORT: Record<string, string> = { low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };

/** The words the models-for-each-role ledger shows: model names, never-use pairs, times and the unsaved-change list. */
export class LedgerText {
  static label(state: ModelRoutingState, provider: string, model: string): string {
    return model ? modelName(state, provider, model) : 'No model chosen';
  }

  static pairText(state: ModelRoutingState, pair: NeverUsePair): string {
    return `${ LedgerText.label(state, pair.provider, pair.model) } at ${ pair.effort === 'any' ? 'any effort' : effortLabel(pair.effort) }`;
  }

  static effortShort(id: string): string { return SHORT[id] ?? effortLabel(id) }

  static ago(now: number, iso: string | null | undefined): string {
    if (!iso) return 'not yet';
    const min = Math.round((now - Date.parse(iso)) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${ min } min ago`;
    const h = Math.round(min / 60);
    return h < 24 ? `${ h } h ago` : new Date(iso).toLocaleDateString();
  }

  /** One line per unsaved change, in the order the roles appear, then never-use additions and removals. */
  static pending(state: ModelRoutingState, saved: Lanes, draft: Lanes, never: readonly NeverUsePair[], changedRoles: readonly ModelClass[], connected: (provider: string) => boolean): string[] {
    const out: string[] = [];
    const label = (p: string, m: string) => LedgerText.label(state, p, m);
    for (const c of changedRoles) {
      const a = saved[c]; const b = draft[c]; const name = CLASS_LABELS[c];
      for (const m of b) if (!a.some(x => x.provider === m.provider)) out.push(`${ name }: added ${ providerName(state, m.provider) }`);
      for (const m of a) if (!b.some(x => x.provider === m.provider)) out.push(`${ name }: removed ${ providerName(state, m.provider) }`);
      const keptA = a.filter(m => b.some(x => x.provider === m.provider)).map(m => m.provider).join();
      const keptB = b.filter(m => a.some(x => x.provider === m.provider)).map(m => m.provider).join();
      if (keptA !== keptB) out.push(`${ name }: new order ${ b.filter(m => connected(m.provider)).map(m => providerName(state, m.provider)).join(', then ') }`);
      for (const m of b) {
        const old = a.find(x => x.provider === m.provider);
        if (!old) continue;
        const p = providerName(state, m.provider);
        if (old.model !== m.model || JSON.stringify(old.rule ?? null) !== JSON.stringify(m.rule ?? null)) out.push(`${ name }, ${ p }: ${ label(m.provider, old.model) } to ${ label(m.provider, m.model) }`);
        if ((old.effort ?? '') !== (m.effort ?? '')) out.push(`${ name }, ${ p }: effort ${ old.effort ? effortLabel(old.effort) : 'default' } to ${ m.effort ? effortLabel(m.effort) : 'default' }`);
      }
    }
    const before = state.neverUse ?? [];
    for (const b of never) if (!before.some(x => x.provider === b.provider && x.model === b.model && x.effort === b.effort)) out.push(`Never use ${ LedgerText.pairText(state, b) }`);
    for (const b of before) if (!never.some(x => x.provider === b.provider && x.model === b.model && x.effort === b.effort)) out.push(`Allowed again: ${ LedgerText.pairText(state, b) }`);
    return out;
  }
}
