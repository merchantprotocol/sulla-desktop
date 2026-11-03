// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const settings = new Map<string, any>();
const agents = new Map<string, any>();

jest.unstable_mockModule('../index', () => ({
  PROVIDER_FACTORIES: { 'claude-code': jest.fn(), codex: jest.fn(), openai: jest.fn(), ollama: jest.fn() },
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: jest.fn(async(key: string, fallback: any) => settings.has(key) ? settings.get(key) : fallback),
    set: jest.fn(async(key: string, value: any) => { settings.set(key, value) }),
  },
}));
jest.unstable_mockModule('../../services/AgentDefinitionService', () => ({
  agentDefinitionService: {
    findBySlug: jest.fn(async(slug: string) => agents.get(slug) ?? null),
    list:       jest.fn(async() => [...agents.values()]),
  },
}));
jest.unstable_mockModule('../../services/AgentDirectoryService', () => ({ isFrontDoorAgent: () => true }));

function agent(slug: string, extra: Record<string, unknown> = {}) {
  return { slug, name: slug[0].toUpperCase() + slug.slice(1), enabled: true, status: 'production', when_to_call: '', description: '', provider: null, model: null, model_choice: null, ...extra };
}

describe('model defaults', () => {
  beforeEach(() => {
    settings.clear(); agents.clear();
    agents.set('heartbeat', agent('heartbeat'));
    agents.set('director', agent('director', { name: 'Director', when_to_call: 'A project has a planned TASKS.md; more detail here' }));
  });

  it('ships Sulla for new chats and the Heartbeat agent for the heartbeat, Sulla when Heartbeat is off', async() => {
    const { getModelDefaults } = await import('../modelDefaults');
    expect(await getModelDefaults()).toEqual({ chat: { kind: 'agent', agentId: 'sulla' }, heartbeat: { kind: 'agent', agentId: 'heartbeat' } });
    settings.clear(); agents.get('heartbeat').enabled = false;
    expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'agent', agentId: 'sulla' });
  });

  describe('migration from heartbeatProvider / heartbeatModelId', () => {
    it('maps legacy tiers to classes', async() => {
      const { getModelDefaults } = await import('../modelDefaults');
      for (const [tier, cls] of [['fast', 'fast'], ['balanced', 'standard'], ['powerful', 'frontier']]) {
        settings.clear(); settings.set('heartbeatProvider', 'claude-code'); settings.set('heartbeatModelId', tier);
        expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'model', choice: { mode: 'class', class: cls } });
      }
    });
    it('pins an exact legacy model and uses Fast when no model was set', async() => {
      const { getModelDefaults } = await import('../modelDefaults');
      settings.set('heartbeatProvider', 'codex'); settings.set('heartbeatModelId', 'gpt-5.5');
      expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'model', choice: { mode: 'pin', provider: 'codex', model: 'gpt-5.5' } });
      settings.clear(); settings.set('heartbeatProvider', 'codex');
      expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'model', choice: { mode: 'class', class: 'fast' } });
    });
    it('keeps the shipped default for "default" or an unknown provider', async() => {
      const { getModelDefaults } = await import('../modelDefaults');
      settings.set('heartbeatProvider', 'default'); settings.set('heartbeatModelId', 'powerful');
      expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'agent', agentId: 'heartbeat' });
      settings.clear(); settings.set('heartbeatProvider', 'gone-provider'); settings.set('heartbeatModelId', 'x');
      expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'agent', agentId: 'heartbeat' });
    });
    it('migrates once, persists, and leaves the old keys readable', async() => {
      const { getModelDefaults } = await import('../modelDefaults');
      settings.set('heartbeatProvider', 'claude-code'); settings.set('heartbeatModelId', 'fast');
      await getModelDefaults();
      expect(settings.get('modelDefaults').heartbeat).toEqual({ kind: 'model', choice: { mode: 'class', class: 'fast' } });
      expect(settings.get('heartbeatProvider')).toBe('claude-code');
      settings.set('heartbeatModelId', 'powerful'); // later edits to the old keys no longer apply
      expect((await getModelDefaults()).heartbeat).toEqual({ kind: 'model', choice: { mode: 'class', class: 'fast' } });
    });
    it('repairs a damaged saved row without losing the valid one', async() => {
      const { getModelDefaults } = await import('../modelDefaults');
      settings.set('modelDefaults', { chat: { kind: 'model', choice: { mode: 'class', class: 'coding' } }, heartbeat: { kind: 'agent' } });
      expect(await getModelDefaults()).toEqual({ chat: { kind: 'model', choice: { mode: 'class', class: 'coding' } }, heartbeat: { kind: 'agent', agentId: 'heartbeat' } });
    });
  });

  it('validates what the human picks', async() => {
    const { setModelDefaults } = await import('../modelDefaults');
    await expect(setModelDefaults({ chat: { kind: 'agent', agentId: 'missing' } })).rejects.toThrow('exist and be enabled');
    agents.get('director').enabled = false;
    await expect(setModelDefaults({ chat: { kind: 'agent', agentId: 'director' } })).rejects.toThrow('exist and be enabled');
    await expect(setModelDefaults({ chat: { kind: 'model', choice: { mode: 'pin', provider: 'missing', model: 'x' } } })).rejects.toThrow('Unknown model provider');
    await expect(setModelDefaults({ chat: { kind: 'model', choice: { mode: 'class', class: 'bogus' } } as any })).rejects.toThrow('Invalid model default');
    await expect(setModelDefaults({ heartbeat: { kind: 'model', choice: { mode: 'pin', provider: 'codex', model: 'gpt-5.5' } } }))
      .resolves.toEqual({ chat: { kind: 'agent', agentId: 'sulla' }, heartbeat: { kind: 'model', choice: { mode: 'pin', provider: 'codex', model: 'gpt-5.5' } } });
  });

  it('reset restores the shipped defaults', async() => {
    const { resetModelDefaults, setModelDefaults } = await import('../modelDefaults');
    await setModelDefaults({ chat: { kind: 'agent', agentId: 'director' } });
    expect(await resetModelDefaults()).toEqual({ chat: { kind: 'agent', agentId: 'sulla' }, heartbeat: { kind: 'agent', agentId: 'heartbeat' } });
  });

  it('lists enabled agents only, Sulla first, with the first clause of when-to-call', async() => {
    const { modelDefaultsState } = await import('../modelDefaults');
    agents.set('integrator', agent('integrator', { enabled: false }));
    agents.set('opus-worker', agent('opus-worker', { provider: 'claude-code', model: 'claude-opus-5-5' }));
    const state = await modelDefaultsState();
    expect(state.agents.map(a => a.slug)).toEqual(['sulla', 'heartbeat', 'director', 'opus-worker']);
    expect(state.agents.find(a => a.slug === 'director')!.whenToCall).toBe('A project has a planned TASKS.md');
    expect(state.agents.find(a => a.slug === 'opus-worker')!.modelChoice).toEqual({ mode: 'pin', provider: 'claude-code', model: 'claude-opus-5-5' });
    expect(state.recommended).toEqual({ chat: { kind: 'agent', agentId: 'sulla' }, heartbeat: { kind: 'agent', agentId: 'heartbeat' } });
  });

  describe('new chat routing', () => {
    it('an agent default routes to that agent with no thread model choice', async() => {
      const { setModelDefaults } = await import('../modelDefaults');
      const { resolveDefaultRouteAgent } = await import('../../services/ChatAgentRouting');
      await setModelDefaults({ chat: { kind: 'agent', agentId: 'director' } });
      expect(await resolveDefaultRouteAgent()).toEqual({ agentId: 'director', graphAgentId: 'director', name: 'Director' });
    });
    it('a model default routes to Sulla carrying the model choice', async() => {
      const { setModelDefaults } = await import('../modelDefaults');
      const { resolveDefaultRouteAgent } = await import('../../services/ChatAgentRouting');
      await setModelDefaults({ chat: { kind: 'model', choice: { mode: 'class', class: 'coding' } } });
      expect(await resolveDefaultRouteAgent()).toEqual({ agentId: 'sulla', graphAgentId: 'sulla-desktop', name: 'Sulla', modelChoice: { mode: 'class', class: 'coding' } });
    });
    it('a saved agent that was turned off falls back to Sulla', async() => {
      const { setModelDefaults, resolveDefaultChoice, getModelDefaults } = await import('../modelDefaults');
      await setModelDefaults({ chat: { kind: 'agent', agentId: 'director' } });
      agents.get('director').enabled = false;
      const resolved = await resolveDefaultChoice((await getModelDefaults()).chat);
      expect(resolved.agent.agentId).toBe('sulla');
      expect(resolved.fellBack).toBe(true);
    });
    it('the thread keeps a model choice only while its route carries one', async() => {
      const { applyThreadAgentRoute } = await import('../../services/ChatAgentRouting');
      const state: any = { metadata: {} };
      applyThreadAgentRoute(state, { agentId: 'sulla', graphAgentId: 'sulla-desktop', name: 'Sulla', modelChoice: { mode: 'class', class: 'fast' } });
      expect(state.metadata.modelChoice).toEqual({ mode: 'class', class: 'fast' });
      applyThreadAgentRoute(state, { agentId: 'director', graphAgentId: 'director', name: 'Director' });
      expect(state.metadata.modelChoice).toBeUndefined();
      expect(state.metadata.routedAgentId).toBe('director');
    });
  });

  describe('model choice precedence', () => {
    it('explicit per-task pin > thread choice > agent setting > list', async() => {
      const { effectiveModelChoice } = await import('../threadModelChoice');
      const thread = { modelChoice: { mode: 'class', class: 'coding' } };
      const agentChoice = { mode: 'class', class: 'frontier' } as const;
      expect(effectiveModelChoice({ provider: 'codex', model: 'gpt-5.5', metadata: thread, agentChoice })).toEqual({ mode: 'pin', provider: 'codex', model: 'gpt-5.5' });
      expect(effectiveModelChoice({ provider: 'codex', model: 'primary', metadata: thread, agentChoice })).toEqual({ mode: 'class', class: 'coding' });
      expect(effectiveModelChoice({ metadata: {}, agentChoice })).toEqual({ mode: 'class', class: 'frontier' });
      expect(effectiveModelChoice({ metadata: { modelChoice: { mode: 'class', class: 'bogus' } }, agentChoice: null })).toEqual({ mode: 'list' });
    });
  });
});
