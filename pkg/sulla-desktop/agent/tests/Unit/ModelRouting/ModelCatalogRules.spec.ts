// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { applyRules, compareCatalogs, effectiveEffort, isPairBlocked, isUnlisted, resolveRule } from '../../../languagemodels/modelCatalogRules';
import { ModelRouter, type EditableState } from '../../../languagemodels/modelRouter';

vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { codex: {}, grok: {} } }));

// Codex's live list as it reports it today, including its "Auto" mode entry first.
const codex = [{ id: 'codex', label: 'Auto (CLI default)' }, { id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-sol' }, { id: 'gpt-6-luna', label: 'GPT-6 Luna' }, { id: 'gpt-5.6-luna' }];
const none = { frontier: [], standard: [], fast: [], coding: [], local: [] };

describe('model rules pick from the live list without knowing model names', () => {
  // risk: a rule that picks the CLI's "Auto" mode would silently hand model choice back to the CLI
  it('"first model in the list" skips the Auto mode entry', () => {
    expect(resolveRule({ kind: 'first' }, 'codex', codex, [])).toBe('gpt-6-astra');
  });

  it('"name contains" matches IDs or labels, case-insensitively, in the provider\'s order', () => {
    expect(resolveRule({ kind: 'contains', text: 'LUNA' }, 'codex', codex, [])).toBe('gpt-6-luna');
    expect(resolveRule({ kind: 'contains', text: 'nothing-like-this' }, 'codex', codex, [])).toBeNull();
  });

  // risk: the user's banned model (gpt-6.1-sol) must never be picked by a rule
  it('rules skip never-use models and take the next match', () => {
    expect(resolveRule({ kind: 'contains', text: 'sol' }, 'codex', codex, [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'any' }])).toBe('gpt-6-sol');
  });

  it('re-resolving reports each rule entry that moved, and leaves fixed IDs alone', () => {
    const classes = { ...none, fast: [{ provider: 'codex', model: 'gpt-5.6-luna', rule: { kind: 'contains' as const, text: 'luna' } }], coding: [{ provider: 'codex', model: 'gpt-5.3-codex' }] };
    const { classes: next, moved } = applyRules(classes, new Map([['codex', codex]]), []);

    expect(next.fast[0].model).toBe('gpt-6-luna');
    expect(next.coding[0].model).toBe('gpt-5.3-codex');
    expect(moved).toEqual([{ class: 'fast', provider: 'codex', from: 'gpt-5.6-luna', to: 'gpt-6-luna' }]);
  });

  // risk: a provider whose list failed to load must not wipe out a working role
  it('keeps the last pick when the provider reports no list', () => {
    const classes = { ...none, fast: [{ provider: 'codex', model: 'gpt-5.6-luna', rule: { kind: 'first' as const } }] };
    expect(applyRules(classes, new Map([['codex', []]]), []).classes.fast[0].model).toBe('gpt-5.6-luna');
  });
});

describe('models missing from the live list are visible instead of failing mid-job', () => {
  // risk: a fixed fallback list (Claude subscriptions) must not brand working models as missing
  it('a fixed fallback list proves nothing about missing models', () => {
    expect(isUnlisted({ provider: 'claude-code', model: 'claude-sonnet-5-5' }, [{ id: 'claude-code' }, { id: 'claude-sonnet-5', unverified: true }])).toBe(false);
  });

  it('a saved model the provider does not list is flagged; an empty list proves nothing', () => {
    expect(isUnlisted({ provider: 'codex', model: 'gpt-5.3-codex' }, codex)).toBe(true);
    expect(isUnlisted({ provider: 'codex', model: 'gpt-6-sol' }, codex)).toBe(false);
    expect(isUnlisted({ provider: 'codex', model: 'gpt-5.3-codex' }, [])).toBe(false);
  });

  it('refresh reports models added and removed per provider, ignoring providers seen for the first time', () => {
    const report = compareCatalogs({ codex: ['codex', 'gpt-5.3-codex', 'gpt-6-sol'] }, { codex: ['codex', 'gpt-6-sol', 'gpt-6-luna'], grok: ['grok-5'] });
    expect(report).toEqual({ added: [{ provider: 'codex', model: 'gpt-6-luna' }], removed: [{ provider: 'codex', model: 'gpt-5.3-codex' }] });
  });
});

describe('never-use entries are model and effort pairs', () => {
  const pairs = [{ provider: 'codex', model: 'gpt-6-astra', effort: 'low' }];

  // risk: an entry left on "Default" still runs at the model's default level, so a pair on that level must catch it
  it('matches an entry on Default effort through the model\'s reported default', () => {
    const effort = effectiveEffort({ model: 'gpt-6-astra' }, [{ id: 'gpt-6-astra', defaultEffort: 'low' }]);
    expect(isPairBlocked(pairs, 'codex', 'gpt-6-astra', effort)).toBe(true);
  });

  it('does not block the same model at another effort, or another model at the same effort', () => {
    expect(isPairBlocked(pairs, 'codex', 'gpt-6-astra', 'high')).toBe(false);
    expect(isPairBlocked(pairs, 'codex', 'gpt-6-sol', 'low')).toBe(false);
  });
});

describe('routing honors rules and the never-use list', () => {
  const saved: EditableState = {
    agentsList:          [{ provider: 'codex', class: 'coding', enabled: true }, { provider: 'grok', class: 'coding', enabled: true }],
    subconsciousList:    [],
    classes:             { ...none, coding: [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'grok', model: 'grok-code' }], fast: [{ provider: 'codex', model: 'gpt-5.6-luna', rule: { kind: 'contains', text: 'luna' } }], frontier: [{ provider: 'codex', model: 'gpt-6-sol', effort: 'high' }], standard: [{ provider: 'codex', model: 'gpt-6-sol', effort: 'max' }] },
    followProviderOrder: { frontier: true, standard: true, fast: true, coding: true, local: true },
    neverUse:            [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'any' }, { provider: 'codex', model: 'gpt-6-sol', effort: 'max' }],
  };
  const router = () => new ModelRouter(() => ({
    getAvailableProviders: () => Promise.resolve([{ id: 'codex', connected: true }, { id: 'grok', connected: true }]),
    getModelsForProvider:  (id: string) => Promise.resolve(id === 'codex' ? codex : [{ id: 'grok-code' }]),
  }));

  beforeEach(() => {
    vi.spyOn(SullaSettingsModel, 'get').mockImplementation((key: string, fallback: any) => Promise.resolve(key === 'modelRouting' ? structuredClone(saved) : fallback));
    vi.spyOn(SullaSettingsModel, 'set').mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  // risk: a blocked model left in a role would still be tried and fail or cost money
  it('skips a never-use model even when it is first in the role', async() => {
    expect(await router().resolve('agents', { mode: 'class', class: 'coding' })).toEqual([{ provider: 'grok', model: 'grok-code' }]);
  });

  it('routes a rule entry to what the rule picks from the live list now', async() => {
    const [first] = await router().resolve('agents', { mode: 'class', class: 'fast' });
    expect(first.model).toBe('gpt-6-luna');
  });

  // risk: the effort the user set for a role must reach the run, but a never-use pair (GPT-6 Sol at Max) must never run
  it('carries a role entry\'s effort to the run, and skips an entry that matches a never-use pair', async() => {
    expect(await router().resolve('agents', { mode: 'class', class: 'frontier' })).toEqual([{ provider: 'codex', model: 'gpt-6-sol', effort: 'high' }]);
    expect(await router().resolve('agents', { mode: 'class', class: 'standard' })).toEqual([]);
  });

  // risk: a pair blocks only its own effort; the same model at another effort must still run
  it('a never-use pair leaves the same model usable at other efforts', async() => {
    expect(await router().resolve('agents', { mode: 'class', class: 'frontier' })).toHaveLength(1);
  });

  it('an explicit pin is a hard boundary, even for a never-use model', async() => {
    expect(await router().resolve('agents', { mode: 'pin', provider: 'codex', model: 'gpt-6.1-sol' })).toEqual([{ provider: 'codex', model: 'gpt-6.1-sol' }]);
  });
});

describe('live provider snapshots', () => {
  const liveState: EditableState = {
    agentsList: [], subconsciousList: [],
    classes: { frontier: [], standard: [], fast: [], coding: [], local: [] },
    followProviderOrder: { frontier: true, standard: true, fast: true, coding: true, local: true }, neverUse: [],
  };
  beforeEach(() => {
    vi.spyOn(SullaSettingsModel, 'get').mockImplementation((key: string, fallback: any) => Promise.resolve(key === 'modelRouting' ? structuredClone(liveState) : fallback));
    vi.spyOn(SullaSettingsModel, 'set').mockResolvedValue(undefined as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('shares one cold provider-discovery request across concurrent callers', async () => {
    // risk: concurrent graph turns duplicate provider/vault/catalog discovery and delay first model calls
    const getAvailableProviders = vi.fn(async () => [{ id: 'codex', connected: true }]);
    const router = new ModelRouter(() => ({ getAvailableProviders, getModelsForProvider: async () => codex }));
    await Promise.all([router.providerInfo(), router.providerInfo(), router.providerInfo()]);
    expect(getAvailableProviders).toHaveBeenCalledTimes(1);
  });

  it('expires snapshots after the short TTL and invalidates them after routing settings writes', async () => {
    // risk: stale connection/model routing remains active after settings or provider changes
    vi.useFakeTimers();
    const getAvailableProviders = vi.fn(async () => [{ id: 'codex', connected: true }]);
    const router = new ModelRouter(() => ({ getAvailableProviders, getModelsForProvider: async () => codex }));
    await router.providerInfo();
    await router.providerInfo();
    expect(getAvailableProviders).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    await router.providerInfo();
    expect(getAvailableProviders).toHaveBeenCalledTimes(2);
    await router.set({ agentsList: [] });
    await router.providerInfo();
    expect(getAvailableProviders).toHaveBeenCalledTimes(3);
  });

  it('serves the last snapshot while an expired snapshot refreshes in the background', async () => {
    // risk: a slow discovery network call stalls a user turn instead of using the last safe route snapshot
    vi.useFakeTimers();
    let release!: (rows: any[]) => void;
    const getAvailableProviders = vi.fn()
      .mockResolvedValueOnce([{ id: 'codex', connected: true }])
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const router = new ModelRouter(() => ({ getAvailableProviders, getModelsForProvider: async () => codex }));
    const original = await router.providerInfo();
    await vi.advanceTimersByTimeAsync(30_001);
    const duringRefresh = await router.providerInfo();
    expect(duringRefresh).toEqual(original);
    expect(getAvailableProviders).toHaveBeenCalledTimes(2);
    release([{ id: 'codex', connected: false }]);
  });
});
