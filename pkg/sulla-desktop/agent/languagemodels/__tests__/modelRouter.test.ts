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
const providerService = () => ({
  getAvailableProviders: async() => [...connected].map(id => ({ id, connected: true })),
  getModelsForProvider: async(id: string) => models[id] || [],
});

describe('ModelRouter', () => {
  beforeEach(() => { settings.clear(); connected.clear(); Object.keys(models).forEach(key => delete models[key]) });

  it('walks configured order and skips disabled providers while keeping backed-off providers last', async() => {
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
    const router = new ModelRouter(providerService);
    await router.markFailure('Codex', new Error('temporary'));
    await router.markFailure('codex', new Error('temporary'));
    await router.markFailure('CODEX', new Error('temporary'));
    await expect(router.resolve('agents')).resolves.toEqual([
      { provider: 'claude-code', model: 'sonnet' },
      { provider: 'codex', model: 'codex-x' },
    ]);
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
    await expect(new ModelRouter(providerService).resolve('agents')).resolves.toEqual([{ provider: 'codex', model: 'codex-x' }]);
  });

  it('an agent asking for an empty class walks the fallback chain (coding → standard → frontier, local → none)', async() => {
    const { ModelRouter } = await import('../modelRouter');
    connected.add('claude-code'); connected.add('ollama');
    settings.set('modelRouting', {
      agentsList: [], subconsciousList: [],
      classes: { frontier: [{ provider: 'claude-code', model: 'opus' }], standard: [], fast: [], coding: [], local: [] },
      followProviderOrder: {},
    });
    const router = new ModelRouter(providerService);
    await expect(router.resolve('agents', { mode: 'class', class: 'coding' })).resolves.toEqual([{ provider: 'claude-code', model: 'opus' }]);
    await expect(router.resolve('agents', { mode: 'class', class: 'local' })).resolves.toEqual([]);
  });

  it('a class reset restores the recommended models and turns provider order back on', async() => {
    const { ModelRouter, recommendedState } = await import('../modelRouter');
    const router = new ModelRouter(providerService);
    await router.set({ classes: { ...recommendedState().classes, coding: [] }, followProviderOrder: { ...recommendedState().followProviderOrder, coding: false } });
    const next = await router.reset({ section: 'classes', class: 'coding' });
    expect(next.classes.coding).toEqual(recommendedState().classes.coding);
    expect(next.followProviderOrder.coding).toBe(true);
  });

  it('keeps a pin exact and never adds an online fallback', async() => {
    const { ModelRouter } = await import('../modelRouter');
    connected.add('claude-code'); connected.add('codex');
    await expect(new ModelRouter(providerService).resolve('agents', { mode: 'pin', provider: 'claude-code', model: 'opus' }))
      .resolves.toEqual([{ provider: 'claude-code', model: 'opus' }]);
  });

  it('uses free failures, backs off after three, normalizes ids, and success restores order', async() => {
    const { ModelRouter } = await import('../modelRouter');
    connected.add('claude-code'); connected.add('codex');
    settings.set('modelRouting', {
      agentsList: [{ provider: 'claude-code', class: 'standard', enabled: true }, { provider: 'codex', class: 'coding', enabled: true }],
      subconsciousList: [],
      classes: { frontier: [], standard: [{ provider: 'claude-code', model: 'sonnet' }], fast: [], coding: [{ provider: 'codex', model: 'codex-x' }], local: [] },
      followProviderOrder: {},
    });
    const router = new ModelRouter(providerService);
    await router.markFailure('Claude Code', new Error('temporary'));
    expect(await router.isUnavailable('claude-code')).toBe(false);
    await router.markFailure('CLAUDE_CODE', new Error('temporary'));
    expect(await router.isUnavailable('claude-code')).toBe(false);
    await router.markFailure('claude-code', new Error('temporary'));
    expect(await router.isUnavailable('Claude Code')).toBe(true);
    await expect(router.resolve('agents')).resolves.toEqual([{ provider: 'codex', model: 'codex-x' }, { provider: 'claude-code', model: 'sonnet' }]);
    await router.markSuccess('Claude Code');
    await expect(router.resolve('agents')).resolves.toEqual([{ provider: 'claude-code', model: 'sonnet' }, { provider: 'codex', model: 'codex-x' }]);
  });

  it('resets health when every connected candidate is backed off and never returns empty', async() => {
    const { ModelRouter } = await import('../modelRouter');
    connected.add('claude-code'); connected.add('codex');
    settings.set('modelRouting', {
      agentsList: [{ provider: 'claude-code', class: 'standard', enabled: true }, { provider: 'codex', class: 'coding', enabled: true }],
      subconsciousList: [],
      classes: { frontier: [], standard: [{ provider: 'claude-code', model: 'sonnet' }], fast: [], coding: [{ provider: 'codex', model: 'codex-x' }], local: [] }, followProviderOrder: {},
    });
    const router = new ModelRouter(providerService);
    for (const provider of ['claude-code', 'codex']) for (let i = 0; i < 3; i++) await router.markFailure(provider, new Error('temporary'));
    await expect(router.resolve('agents')).resolves.toHaveLength(2);
    expect(await router.isUnavailable('claude-code')).toBe(false);
    expect(await router.isUnavailable('codex')).toBe(false);
  });

  it('returns only an exact pin even when disconnected and unhealthy', async() => {
    const { ModelRouter } = await import('../modelRouter');
    const router = new ModelRouter(providerService);
    for (let i = 0; i < 3; i++) await router.markFailure('Claude Code', new Error('temporary'));
    await expect(router.resolve('agents', { mode: 'pin', provider: 'Claude Code', model: 'opus' }))
      .resolves.toEqual([{ provider: 'claude-code', model: 'opus' }]);
  });

  it('does not count interrupted or Sulla infrastructure failures', async() => {
    const { ModelRouter } = await import('../modelRouter');
    const router = new ModelRouter(providerService);
    for (let i = 0; i < 4; i++) await router.markFailure('codex', new Error(i % 2 ? 'CLI run aborted' : 'sulla-runtime exec failed: ENOENT /dev/shm/sulla-agent-secrets/job/mcp.json'));
    expect(await router.isUnavailable('codex')).toBe(false);
  });

  it('ignores a stale failure from an attempt that began before a success', async() => {
    const { ModelRouter } = await import('../modelRouter');
    const router = new ModelRouter(providerService);
    const stale = router.attemptToken('codex');
    await router.markSuccess('codex');
    for (let i = 0; i < 4; i++) await router.markFailure('codex', new Error('temporary'), undefined, stale);
    expect(await router.isUnavailable('codex')).toBe(false);
  });

  it('does not count a typed Codex-not-installed infrastructure failure', async() => {
    const { ModelRouter } = await import('../modelRouter');
    const { InfrastructureFailure } = await import('../providerRecovery');
    const router = new ModelRouter(providerService);
    for (let i = 0; i < 4; i++) await router.markFailure('codex', new InfrastructureFailure('codex CLI is not installed in the VM yet'));
    expect(await router.isUnavailable('codex')).toBe(false);
  });

  it('wipes malformed legacy health without loading it', async() => {
    const { ModelRouter } = await import('../modelRouter');
    settings.set('modelRoutingProviderHealth', '{}');
    await expect(new ModelRouter(providerService).isUnavailable('codex')).resolves.toBe(false);
  });

  it('migrates legacy primary, secondary, and subconscious slots once', async() => {
    const { ModelRouter } = await import('../modelRouter');
    settings.set('primaryProvider', 'claude-code'); settings.set('activeModelId', 'opus');
    settings.set('secondaryProvider', 'codex'); settings.set('secondaryModelId', 'codex-x');
    settings.set('subconsciousProvider', 'ollama'); settings.set('subconsciousModelId', 'llama');
    const state = await new ModelRouter(providerService).getEditableState();
    expect(state.agentsList.map(row => row.provider)).toEqual(['codex', 'claude-code']);
    expect(state.subconsciousList[0].provider).toBe('ollama');
    expect(settings.has('modelRouting')).toBe(true);
  });

  it('rejects unknown providers, classes, and non-local Local rows', async() => {
    const { ModelRouter } = await import('../modelRouter');
    const router = new ModelRouter(providerService);
    expect(() => router.validatePatch({ agentsList: [{ provider: 'wat', class: 'fast', enabled: true }] })).toThrow('Unknown model provider');
    expect(() => router.validatePatch({ agentsList: [{ provider: 'codex', class: 'bogus' as any, enabled: true }] })).toThrow('Unknown model class');
    expect(() => router.validatePatch({ agentsList: [{ provider: 'codex', class: 'local', enabled: true }] })).toThrow('cannot use the local class');
  });
});
