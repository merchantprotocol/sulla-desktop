// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ClassModel, ModelClass, ModelRoutingState, RoutingProviderInfo, RoutingRow } from '@pkg/agent/languagemodels/modelRoutingTypes';

export const CLASS_LABELS: Record<ModelClass, string> = { frontier: 'Frontier', standard: 'Standard', fast: 'Fast', coding: 'Coding', local: 'Local' };
export const CLASS_FALLBACK: Partial<Record<ModelClass, ModelClass>> = { frontier: 'standard', coding: 'standard', fast: 'standard', standard: 'frontier' };

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return [...items];
  const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
export function modelsForProvider(state: ModelRoutingState, provider: RoutingProviderInfo): ModelClass[] {
  return (Object.keys(CLASS_LABELS) as ModelClass[]).filter(c => (c !== 'local' || provider.local) && state.classes[c].some(m => m.provider === provider.id));
}
export function resolvedModel(state: ModelRoutingState, row: RoutingRow): ClassModel | undefined {
  return state.classes[row.class].find(m => m.provider === row.provider);
}
export function providerOrder(state: ModelRoutingState): string[] {
  return [...new Set([...state.agentsList.map(r => r.provider), ...state.providers.map(p => p.id)])];
}
export function orderedClassModels(state: ModelRoutingState, modelClass: ModelClass): ClassModel[] {
  if (!state.followProviderOrder[modelClass]) return state.classes[modelClass];
  const order = providerOrder(state); return [...state.classes[modelClass]].sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
}
export interface TraceStep { row: RoutingRow; model?: ClassModel; result: 'use'|'off'|'missing'|'cooling'|'error'|'disconnected'; }
export function traceRoute(state: ModelRoutingState, list: 'agents'|'subconscious'): TraceStep[] {
  const rows = list === 'agents' ? state.agentsList : state.subconsciousList; const out: TraceStep[] = [];
  for (const row of rows) {
    const provider = state.providers.find(p => p.id === row.provider); const model = resolvedModel(state, row);
    let result: TraceStep['result'] = 'use';
    if (!row.enabled) result = 'off'; else if (!model) result = 'missing'; else if (!provider?.connected) result = 'disconnected'; else if (provider.status === 'cooling') result = 'cooling'; else if (provider.status === 'error') result = 'error';
    out.push({ row, model, result }); if (result === 'use') break;
  }
  return out;
}
