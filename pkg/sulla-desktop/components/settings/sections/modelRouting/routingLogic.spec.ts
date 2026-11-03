// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, test } from 'vitest';

import {
  applyFollowOrder, availability, choiceLabel, classNow, classOptions, classSummary, fallbackChain, modelsForProvider, moveItem, orderedClassModels,
  providerName, resolveChoice, resolvedModel, rowChip, sortByProviderOrder, traceClass, traceRoute,
} from './routingLogic';
import type { ModelClass, ModelRoutingState, RoutingProviderInfo } from '@pkg/agent/languagemodels/modelRoutingTypes';

const NOW = Date.parse('2026-11-02T18:12:00Z');
const LATER = new Date(NOW + 28 * 60_000).toISOString();

function provider(id: string, extra: Partial<RoutingProviderInfo> = {}): RoutingProviderInfo {
  return { id, name: id, connected: true, local: false, subscription: false, status: 'ready', coolingUntil: null, lastError: null, models: [], ...extra };
}
function classes(partial: Partial<ModelRoutingState['classes']> = {}): ModelRoutingState['classes'] {
  return { frontier: [], standard: [], fast: [], coding: [], local: [], ...partial };
}
const follow = (on: boolean) => ({ frontier: on, standard: on, fast: on, coding: on, local: on });

function makeState(over: Partial<ModelRoutingState> = {}): ModelRoutingState {
  return {
    agentsList: [
      { provider: 'claude-code', class: 'frontier', enabled: true },
      { provider: 'codex', class: 'frontier', enabled: true },
      { provider: 'claude-code', class: 'standard', enabled: true },
      { provider: 'grok', class: 'frontier', enabled: true },
    ],
    subconsciousList: [
      { provider: 'ollama', class: 'fast', enabled: true },
      { provider: 'claude-code', class: 'fast', enabled: false },
    ],
    classes: classes({
      frontier: [{ provider: 'grok', model: 'grok-4.6' }, { provider: 'claude-code', model: 'claude-opus-5-5' }, { provider: 'codex', model: 'gpt-5.5' }],
      standard: [{ provider: 'claude-code', model: 'claude-sonnet-5-5' }],
      fast:     [{ provider: 'ollama', model: 'llama3.1:8b' }, { provider: 'claude-code', model: 'claude-haiku-5-5' }],
      local:    [{ provider: 'ollama', model: 'llama3.1:8b' }],
    }),
    followProviderOrder: follow(true),
    providers: [provider('claude-code', { subscription: true }), provider('codex', { subscription: true }), provider('grok'), provider('ollama', { local: true }), provider('openai', { connected: false, status: 'disconnected' })],
    ...over,
  };
}
function withStatus(state: ModelRoutingState, id: string, patch: Partial<RoutingProviderInfo>): ModelRoutingState {
  return { ...state, providers: state.providers.map(p => p.id === id ? { ...p, ...patch } : p) };
}

describe('moveItem (reorder)', () => {
  test('moves immutably, both directions', () => {
    const src = [1, 2, 3, 4];
    expect(moveItem(src, 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem(src, 3, 1)).toEqual([1, 4, 2, 3]);
    expect(src).toEqual([1, 2, 3, 4]);
  });
  test('out-of-range or same index is a copy, not a change', () => {
    expect(moveItem([1, 2], 0, 5)).toEqual([1, 2]);
    expect(moveItem([1, 2], -1, 0)).toEqual([1, 2]);
    expect(moveItem([1, 2], 1, 1)).toEqual([1, 2]);
  });
});

describe('follow provider order', () => {
  test('sorts class models by first appearance in the Agents list, stable within a provider', () => {
    const s = makeState({ classes: classes({ coding: [{ provider: 'grok', model: 'g1' }, { provider: 'claude-code', model: 'c1' }, { provider: 'grok', model: 'g2' }, { provider: 'claude-code', model: 'c2' }] }) });
    expect(orderedClassModels(s, 'coding').map(m => m.model)).toEqual(['c1', 'c2', 'g1', 'g2']);
  });
  test('custom order is left alone', () => {
    const s = makeState({ followProviderOrder: { ...follow(true), frontier: false } });
    expect(orderedClassModels(s, 'frontier').map(m => m.provider)).toEqual(['grok', 'claude-code', 'codex']);
  });
  test('providers missing from the Agents list come after it, connected ones first', () => {
    const s = makeState({ agentsList: [{ provider: 'codex', class: 'frontier', enabled: true }] });
    expect(sortByProviderOrder(s, s.classes.frontier).map(m => m.provider)).toEqual(['codex', 'claude-code', 'grok']);
  });
  test('applyFollowOrder re-sorts only following classes', () => {
    const s = makeState({ followProviderOrder: { ...follow(true), fast: false } });
    const out = applyFollowOrder(s);
    expect(out.frontier.map(m => m.provider)).toEqual(['claude-code', 'codex', 'grok']);
    expect(out.fast.map(m => m.provider)).toEqual(['ollama', 'claude-code']);
  });
});

describe('rows and classes', () => {
  test('a row resolves to its provider’s first model in the class', () => {
    expect(resolvedModel(makeState(), { provider: 'codex', class: 'frontier' })?.model).toBe('gpt-5.5');
    expect(resolvedModel(makeState(), { provider: 'codex', class: 'fast' })).toBeUndefined();
  });
  test('classes per provider; Local only for providers on this Mac', () => {
    const s = makeState({ classes: classes({ local: [{ provider: 'grok', model: 'x' }, { provider: 'ollama', model: 'y' }] }) });
    expect(modelsForProvider(s, s.providers[2])).toEqual([]);
    expect(modelsForProvider(s, s.providers[3])).toEqual(['local']);
  });
  test('class selector keeps the row’s empty class and disables pairs already in the list', () => {
    const s = makeState();
    const opts = classOptions(s, s.agentsList, s.agentsList[0]);
    expect(opts.map(o => o.label)).toEqual(['Frontier', 'Standard (in list)', 'Fast']);
    expect(opts.find(o => o.value === 'standard')?.disabled).toBe(true);
    const empty = { provider: 'codex', class: 'coding' as ModelClass, enabled: true };
    expect(classOptions(s, [empty], empty).map(o => o.label)).toEqual(['Frontier', 'Coding (no models)']);
  });
  test('row chips: skipped, no model, cooling, error', () => {
    const s = makeState();
    expect(rowChip(s, { provider: 'claude-code', class: 'fast', enabled: false }, NOW)).toEqual({ kind: 'off', label: 'Skipped' });
    expect(rowChip(s, { provider: 'codex', class: 'fast', enabled: true }, NOW)).toEqual({ kind: 'off', label: 'No Fast model' });
    expect(rowChip(withStatus(s, 'codex', { status: 'cooling', coolingUntil: LATER }), s.agentsList[1], NOW).label).toMatch(/^Cooling down until /);
    expect(rowChip(withStatus(s, 'codex', { status: 'error', lastError: 'Signed out' }), s.agentsList[1], NOW)).toEqual({ kind: 'err', label: 'Error' });
  });
  test('a cooldown that has already reset counts as ready', () => {
    const s = withStatus(makeState(), 'codex', { status: 'cooling', coolingUntil: new Date(NOW - 1000).toISOString() });
    expect(availability(s, 'codex', NOW).ok).toBe(true);
  });
});

describe('traceRoute (lists)', () => {
  test('uses the first ready row; next skips other rows of the same provider', () => {
    const t = traceRoute(makeState(), 'agents', NOW);
    expect(t.steps.map(s => [s.index, s.kind])).toEqual([[0, 'use']]);
    expect(t.chosen?.model?.model).toBe('claude-opus-5-5');
    expect(t.next?.index).toBe(1);
    expect(t.next?.row.provider).toBe('codex');
  });
  test('cooling provider is skipped in every row and recorded as a wait', () => {
    const s = withStatus(makeState(), 'claude-code', { status: 'cooling', coolingUntil: LATER });
    const t = traceRoute(s, 'agents', NOW);
    expect(t.steps.map(x => x.kind)).toEqual(['cool', 'use']);
    expect(t.waits.map(w => w.row.provider)).toEqual(['claude-code']);
    expect(t.next?.row.provider).toBe('grok');
  });
  test('off, missing model and error rows are passed with a reason', () => {
    const s = withStatus(makeState({
      agentsList: [
        { provider: 'claude-code', class: 'frontier', enabled: false },
        { provider: 'codex', class: 'fast', enabled: true },
        { provider: 'grok', class: 'frontier', enabled: true },
        { provider: 'claude-code', class: 'standard', enabled: true },
      ],
    }), 'grok', { status: 'error', lastError: 'Bad key' });
    const t = traceRoute(s, 'agents', NOW);
    expect(t.steps.map(x => [x.kind, x.why])).toEqual([['off', 'Turned off'], ['missing', 'No Fast model'], ['err', 'Bad key'], ['use', '']]);
  });
  test('subconscious walks its own list', () => {
    expect(traceRoute(makeState(), 'subconscious', NOW).chosen?.model?.model).toBe('llama3.1:8b');
  });
  test('nothing ready → no chosen row', () => {
    const t = traceRoute(makeState({ subconsciousList: [] }), 'subconscious', NOW);
    expect(t.chosen).toBeUndefined();
    expect(t.steps).toEqual([]);
  });
});

describe('fallback chain', () => {
  test('fast, coding and frontier fall back to standard; standard to frontier; local nowhere', () => {
    expect(fallbackChain('fast')).toEqual(['fast', 'standard', 'frontier']);
    expect(fallbackChain('coding')).toEqual(['coding', 'standard', 'frontier']);
    expect(fallbackChain('frontier')).toEqual(['frontier', 'standard']);
    expect(fallbackChain('standard')).toEqual(['standard', 'frontier']);
    expect(fallbackChain('local')).toEqual(['local']);
  });
  test('an empty class walks its fallback and says so', () => {
    const t = traceClass(makeState(), 'coding', NOW);
    expect(t.via).toBe('standard');
    expect(t.chosen?.model).toBe('claude-sonnet-5-5');
    expect(classNow(makeState(), 'coding', NOW)).toEqual({ kind: 'ok', label: 'Uses Standard' });
  });
  test('two empty classes never loop', () => {
    const t = traceClass(makeState({ classes: classes() }), 'standard', NOW);
    expect(t.chosen).toBeUndefined();
    expect(t.empty).toEqual(['standard', 'frontier']);
    expect(classNow(makeState({ classes: classes() }), 'local', NOW)).toEqual({ kind: 'off', label: 'Won’t run' });
  });
  test('a class list skips unavailable providers and reports the model in use', () => {
    const s = withStatus(makeState(), 'claude-code', { status: 'cooling', coolingUntil: LATER });
    const t = traceClass(s, 'frontier', NOW);
    expect(t.steps.map(x => x.kind)).toEqual(['cool', 'use']);
    expect(t.chosen?.provider).toBe('codex');
    expect(classNow(s, 'frontier', NOW).inUse).toBe('codex/gpt-5.5');
  });
});

describe('summaries and labels', () => {
  test('collapsed summary shows two models and "+N more" past three', () => {
    const s = makeState({ classes: classes({ standard: ['a', 'b', 'c', 'd'].map(model => ({ provider: 'grok', model })) }) });
    expect(classSummary(s, 'standard', NOW).map(p => p.label)).toEqual(['a', 'b', '+2 more']);
    expect(classSummary(makeState(), 'frontier', NOW).map(p => p.label)).toEqual(['Opus 5.5', 'GPT-5.5', 'Grok 4.6']);
  });
  test('provider ids get display names', () => {
    expect(providerName(makeState(), 'claude-code')).toBe('Claude Code');
    expect(providerName(null, 'mystery')).toBe('mystery');
  });
  test('agent choice labels', () => {
    expect(choiceLabel({ mode: 'list' })).toBe('Agents list');
    expect(choiceLabel({ mode: 'class', class: 'coding' })).toBe('Class: Coding');
    expect(choiceLabel({ mode: 'pin', provider: 'codex', model: 'gpt-5.5' })).toBe('OpenAI Codex · gpt-5.5');
  });
  test('agent choice resolves through the same router', () => {
    expect(resolveChoice(makeState(), { mode: 'list' }, NOW)).toEqual({ model: 'claude-opus-5-5', text: 'through Claude Code (Agents row 1, Frontier)' });
    expect(resolveChoice(makeState(), { mode: 'class', class: 'coding' }, NOW).text).toBe('through Claude Code (Coding is empty, so it uses Standard)');
    expect(resolveChoice(makeState(), { mode: 'pin', provider: 'openai', model: 'gpt-5.5' }, NOW).warn).toBe(true);
  });
});
