// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const settings = new Map<string, any>();
const connected = new Set<string>();
const models: Record<string, any[]> = {};

jest.unstable_mockModule('../index', () => ({
  PROVIDER_FACTORIES: { 'claude-code': jest.fn(), codex: jest.fn(), openai: jest.fn(), ollama: jest.fn() },
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: jest.fn(async(key: string, fallback: any) => settings.has(key) ? settings.get(key) : fallback),
    set: jest.fn(async(key: string, value: any) => { settings.set(key, value) }),
  },
}));
jest.unstable_mockModule('../../services/IntegrationService', () => ({
  getIntegrationService: () => ({ isAnyAccountConnected: async(id: string) => connected.has(id) }),
}));
jest.unstable_mockModule('../../services/ModelProviderService', () => ({
  getModelProviderService: () => ({
    getAvailableProviders: async() => [...connected].map(id => ({ id, connected: true })),
    getModelsForProvider: async(id: string) => models[id] || [],
  }),
}));

describe('ModelRouter', () => {
  beforeEach(() => { settings.clear(); connected.clear(); Object.keys(models).forEach(key => delete models[key]) });

  it('walks configured order and skips disabled, disconnected, and cooling providers', async() => {
    const { ModelRouter } = await import('../modelRouter');
    connected.add('claude-code'); connected.add('codex');
    settings.set('modelRouting', {
      agentsList: [
        { provider: 'openai', class: 'frontier', enabled: true },
        { provider: 'claude-code', class: 'frontier', enabled: false },
        { provider: 'codex', class: 'coding', enabled: true },
        { provider: 'claude-code', class: 'standard', enabled: true },
      ],
      subconsciousList: [],
      classes: { frontier: [{ provider: 'openai', model: 'gpt-x' }], standard: [{ provider: 'claude-code', model: 'sonnet' }], fast: [], coding: [{ provider: 'codex', model: 'codex-x' }], local: [] },
      followProviderOrder: {},
    });
    settings.set('modelRoutingProviderHealth', { codex: { status: 'cooling', until: Date.now() + 60_000, lastError: 'quota' } });
    await expect(new ModelRouter().resolve('agents')).resolves.toEqual([{ provider: 'claude-code', model: 'sonnet' }]);
  });

  it('skips a list row whose class has no model for its provider instead of changing class', async() => {
    const { ModelRouter } = await import('../modelRouter');
    connected.add('claude-code'); connected.add('codex');
    settings.set('modelRouting', {
      agentsList: [
        { provider: 'claude-code', class: 'coding', enabled: true }, // coding is empty: skipped, never moved to standard
        { provider: 'codex', class: 'standard', enabled: true },
      ],
      subconsciousList: [],
      classes: { frontier: [], standard: [{ provider: 'claude-code', model: 'sonnet' }, { provider: 'codex', model: 'codex-x' }], fast: [], coding: [], local: [] },
      followProviderOrder: {},
    });
    await expect(new ModelRouter().resolve('agents')).resolves.toEqual([{ provider: 'codex', model: 'codex-x' }]);
  });

  it('an agent asking for an empty class walks the fallback chain (coding → standard → frontier, local → none)', async() => {
    const { ModelRouter } = await import('../modelRouter');
    connected.add('claude-code'); connected.add('ollama');
    settings.set('modelRouting', {
      agentsList: [], subconsciousList: [],
      classes: { frontier: [{ provider: 'claude-code', model: 'opus' }], standard: [], fast: [], coding: [], local: [] },
      followProviderOrder: {},
    });
    const router = new ModelRouter();
    await expect(router.resolve('agents', { mode: 'class', class: 'coding' })).resolves.toEqual([{ provider: 'claude-code', model: 'opus' }]);
    await expect(router.resolve('agents', { mode: 'class', class: 'local' })).resolves.toEqual([]);
  });

  it('a class reset restores the recommended models and turns provider order back on', async() => {
    const { ModelRouter, recommendedState } = await import('../modelRouter');
    const router = new ModelRouter();
    await router.set({ classes: { ...recommendedState().classes, coding: [] }, followProviderOrder: { ...recommendedState().followProviderOrder, coding: false } });
    const next = await router.reset({ section: 'classes', class: 'coding' });
    expect(next.classes.coding).toEqual(recommendedState().classes.coding);
    expect(next.followProviderOrder.coding).toBe(true);
  });

  it('keeps a pin exact and never adds an online fallback', async() => {
    const { ModelRouter } = await import('../modelRouter');
    connected.add('claude-code'); connected.add('codex');
    await expect(new ModelRouter().resolve('agents', { mode: 'pin', provider: 'claude-code', model: 'opus' }))
      .resolves.toEqual([{ provider: 'claude-code', model: 'opus' }]);
  });

  it('persists a retry-after cooldown and expires it after restart', async() => {
    jest.useFakeTimers();
    const { ModelRouter } = await import('../modelRouter');
    const first = new ModelRouter();
    await first.markFailure('codex', new Error('rate limit'), { 'retry-after': '2' });
    expect(settings.get('modelRoutingProviderHealth').codex.status).toBe('cooling');
    const restarted = new ModelRouter();
    await expect(restarted.isUnavailable('codex')).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(2_001);
    await expect(restarted.isUnavailable('codex')).resolves.toBe(false);
    expect(settings.get('modelRoutingProviderHealth').codex).toBeUndefined();
    jest.useRealTimers();
  });

  it('migrates legacy primary, secondary, and subconscious slots once', async() => {
    const { ModelRouter } = await import('../modelRouter');
    settings.set('primaryProvider', 'claude-code'); settings.set('activeModelId', 'opus');
    settings.set('secondaryProvider', 'codex'); settings.set('secondaryModelId', 'codex-x');
    settings.set('subconsciousProvider', 'ollama'); settings.set('subconsciousModelId', 'llama');
    const state = await new ModelRouter().getEditableState();
    expect(state.agentsList.map(row => row.provider)).toEqual(['codex', 'claude-code']);
    expect(state.subconsciousList[0].provider).toBe('ollama');
    expect(settings.has('modelRouting')).toBe(true);
  });

  it('rejects unknown providers, classes, and non-local Local rows', async() => {
    const { ModelRouter } = await import('../modelRouter');
    const router = new ModelRouter();
    expect(() => router.validatePatch({ agentsList: [{ provider: 'wat', class: 'fast', enabled: true }] })).toThrow('Unknown model provider');
    expect(() => router.validatePatch({ agentsList: [{ provider: 'codex', class: 'bogus' as any, enabled: true }] })).toThrow('Unknown model class');
    expect(() => router.validatePatch({ agentsList: [{ provider: 'codex', class: 'local', enabled: true }] })).toThrow('cannot use the local class');
  });
});
