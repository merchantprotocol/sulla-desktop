// SPDX-License-Identifier: GPL-2.0-or-later
/* Async mocks mirror production interfaces without network or database effects. */
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateChatSelection } from '../../../../main/chatSelection';
import { ModelRoutingIpcController } from '../../../../main/modelRoutingIpc';
import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { ModelRouter, recommendedState } from '../../../languagemodels/modelRouter';
import { MODEL_ROUTING_IPC } from '../../../languagemodels/modelRoutingTypes';
import { assertWorkerBindingsUnchanged } from '../../../languagemodels/workerBindingAuthority';
import { resolveRoutableAgent } from '../../../services/ChatAgentRouting';

const f = vi.hoisted(() => ({ handlers: new Map<string, any>(), store: new Map<string, any>(), agents: [] as any[] }));
vi.mock('electron', () => ({ ipcMain: { removeHandler: (key: string) => f.handlers.delete(key), handle: (key: string, fn: any) => f.handlers.set(key, fn) }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { codex: {}, 'claude-code': {}, grok: {} } }));
vi.mock('../../../services/IntegrationService', () => ({ getIntegrationService: () => ({ onValueChange: vi.fn() }) }));
vi.mock('../../../services/WorkerModelRouting', () => ({ workerModelRouting: { subscriptionConnections: async() => ({ codex: 'subscription-id' }) } }));
// The runtime gates read the same definitions the owner handler lists.
vi.mock('../../../services/AgentDefinitionService', () => ({
  agentDefinitionService: {
    findBySlug: async(slug: string) => f.agents.find(agent => agent.slug === slug) ?? null,
    list:       async() => f.agents,
  },
}));

const candidates = [{ provider: 'codex', model: 'luna', effort: 'max' }];
function save(input: any) { return f.handlers.get(MODEL_ROUTING_IPC.workerSet)(null, { slug: 'luna', agentId: 'luna-id', expectedRevision: 0, expectedToken: '', candidates, ...input }) }
const bindings = () => f.store.get('modelRouting').workerBindings ?? {};

beforeEach(() => {
  f.handlers.clear(); f.store.clear();
  f.agents = [
    { id: 'luna-id', slug: 'luna', name: 'Luna', enabled: false, status: 'production', model_choice: { mode: 'class', class: 'fast' }, run_location: 'container' },
    { id: 'old-id', slug: 'old', name: 'Old', enabled: false, status: 'archive', model_choice: { mode: 'class', class: 'fast' }, run_location: 'container' },
    { id: 'sonnet-id', slug: 'sonnet', name: 'Sonnet', enabled: true, status: 'production', model_choice: { mode: 'class', class: 'fast' }, run_location: 'container' },
  ];
  vi.spyOn(SullaSettingsModel, 'get').mockImplementation(async(key, fallback) => structuredClone(f.store.get(key) ?? fallback));
  vi.spyOn(SullaSettingsModel, 'set').mockImplementation(async(key, value) => {
    if (key === 'modelRouting') assertWorkerBindingsUnchanged(f.store.get(key)?.workerBindings, (value)?.workerBindings);
    f.store.set(key, structuredClone(value));
  });
  f.store.set('modelRouting', { ...recommendedState(), workerBindings: {} });
  const router = new ModelRouter(() => ({ getAvailableProviders: async() => [{ id: 'codex', connected: true }], getModelsForProvider: async() => [{ id: 'luna', efforts: [{ id: 'max' }] }] }));
  new ModelRoutingIpcController({ removeHandler: (key: string) => f.handlers.delete(key), handle: (key: string, fn: any) => f.handlers.set(key, fn) } as any, { router, recommendedState: () => ({}), listAgents: async() => f.agents, onIntegrationValueChange: vi.fn(), broadcast: vi.fn() }).register();
});

describe('owner model settings for a disabled agent', () => {
  it('saves and clears the exact disabled definition mapping while it stays out of the runnable workers list', async() => {
    const state = await save({});
    expect(bindings().luna).toMatchObject({ agentId: 'luna-id', revision: 1, candidates });
    expect(state.workers.map((worker: any) => worker.slug)).toEqual(['sonnet']);
    const opened = bindings().luna;
    await save({ expectedRevision: opened.revision, expectedToken: opened.editToken, candidates: null });
    expect(bindings().luna).toBeUndefined();
  });

  it('keeps identity, archive and stale-revision checks for disabled definitions', async() => {
    await expect(save({ agentId: 'someone-else' })).rejects.toThrow('agent changed');
    await expect(save({ slug: 'old', agentId: 'old-id' })).rejects.toThrow('agent changed');
    await save({});
    await expect(save({})).rejects.toThrow('changed elsewhere');
    expect(bindings().old).toBeUndefined();
  });

  it('a configured disabled agent is still not launchable or selectable for chat routing', async() => {
    await save({});
    expect(await resolveRoutableAgent('luna')).toBeNull();
    expect(await resolveRoutableAgent('sonnet')).toMatchObject({ agentId: 'sonnet' });
  });
});

describe('normal chat agent selection is keyed by slug', () => {
  it('keeps a saved slug and drops a definition id, which would otherwise route to no agent', async() => {
    expect(await validateChatSelection({ agentId: 'sonnet' })).toEqual({ agentId: 'sonnet' });
    expect(await validateChatSelection({ agentId: 'sonnet-id' })).toEqual({});
  });
});
