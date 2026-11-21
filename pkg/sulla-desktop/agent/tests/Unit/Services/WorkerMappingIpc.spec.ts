// SPDX-License-Identifier: GPL-2.0-or-later
/* Async mocks mirror production interfaces without network or database effects. */
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelRoutingIpcController } from '../../../../main/modelRoutingIpc';
import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { ModelRouter, recommendedState } from '../../../languagemodels/modelRouter';
import { assertWorkerBindingsUnchanged, withWorkerBindingWrite } from '../../../languagemodels/workerBindingAuthority';
import { MODEL_ROUTING_IPC } from '../../../languagemodels/modelRoutingTypes';

const f = vi.hoisted(() => ({ handlers: new Map<string, any>(), store: new Map<string, any>(), gate: null as null | Promise<void> }));
vi.mock('electron', () => ({ ipcMain: { removeHandler: (key: string) => f.handlers.delete(key), handle: (key: string, fn: any) => f.handlers.set(key, fn) }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { codex: {}, 'claude-code': {}, grok: {} } }));
vi.mock('../../../services/IntegrationService', () => ({ getIntegrationService: () => ({ onValueChange: vi.fn() }) }));
// Account lookup is the slow step between an owner's opened draft and its save; tests hold it open.
vi.mock('../../../services/WorkerModelRouting', () => ({ workerModelRouting: { subscriptionConnections: async() => { await f.gate; return { codex: 'subscription-id' } } } }));

const candidates = [{ provider: 'codex', model: 'luna', effort: 'max' }];
const agents = ['luna', 'sonnet'].map(slug => ({ id: `${ slug }-id`, slug, name: slug, enabled: true, model_choice: { mode: 'class', class: 'fast' }, run_location: 'container' }));
let router: ModelRouter;
function settings() { return f.store.get('modelRouting') }
function save(input: any) { return f.handlers.get(MODEL_ROUTING_IPC.workerSet)(null, { slug: 'luna', agentId: 'luna-id', expectedRevision: 0, expectedToken: '', candidates, ...input }) }
function hold(): () => void { let release!: () => void; f.gate = new Promise(resolve => { release = resolve }); return () => { f.gate = null; release() } }
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  f.handlers.clear(); f.store.clear(); f.gate = null;
  vi.spyOn(SullaSettingsModel, 'get').mockImplementation(async(key, fallback) => structuredClone(f.store.get(key) ?? fallback));
  // Keep the production owner-write authority check on the settings boundary.
  vi.spyOn(SullaSettingsModel, 'set').mockImplementation(async(key, value) => {
    if (key === 'modelRouting') assertWorkerBindingsUnchanged(f.store.get(key)?.workerBindings, (value as any)?.workerBindings);
    f.store.set(key, structuredClone(value));
  });
  f.store.set('modelRouting', { ...recommendedState(), workerBindings: { sonnet: { agentId: 'sonnet-id', revision: 4, candidates } } });
  router = new ModelRouter(() => ({ getAvailableProviders: async() => [{ id: 'codex', connected: true }], getModelsForProvider: async() => [{ id: 'luna', efforts: [{ id: 'max' }] }] }));
  new ModelRoutingIpcController({ removeHandler: (key: string) => f.handlers.delete(key), handle: (key: string, fn: any) => f.handlers.set(key, fn) } as any, { router, recommendedState: () => ({}), listAgents: async() => agents, onIntegrationValueChange: vi.fn(), broadcast: vi.fn() }).register();
});

describe('owner worker mapping writes', () => {
  it('saves one agent while preserving siblings and rejects generic map writes', async() => {
    const sibling = structuredClone(settings().workerBindings.sonnet); await save({});
    expect(settings().workerBindings.sonnet).toEqual(sibling);
    expect(settings().workerBindings.luna.connections.codex).toBe('subscription-id');
    await expect(f.handlers.get(MODEL_ROUTING_IPC.set)(null, { workerBindings: null })).rejects.toThrow('dedicated');
    await expect(save({ agentId: 'other-owner' })).rejects.toThrow('agent changed');
  });
  it('rejects drafts opened before a reset and requires the current token even when the revision matches', async() => {
    await save({}); const first = structuredClone(settings().workerBindings.luna);
    await save({ expectedRevision: first.revision, expectedToken: first.editToken, candidates: null });
    const inherited = settings().workerInheritance.luna;
    await expect(save({})).rejects.toThrow('changed elsewhere');
    await save({ expectedRevision: inherited.revision, expectedToken: inherited.editToken });
    const replacement = structuredClone(settings().workerBindings.luna);
    expect(replacement.revision).toBeGreaterThan(inherited.revision);
    expect(replacement.editToken).not.toBe(first.editToken);
    await expect(save({ expectedRevision: replacement.revision, expectedToken: first.editToken })).rejects.toThrow('changed elsewhere');
    await expect(save({ expectedRevision: first.revision, expectedToken: first.editToken })).rejects.toThrow('changed elsewhere');
    expect(settings().workerBindings.luna).toEqual(replacement);
  });
  it('serializes concurrent drafts and rejects unsupported effort without erasing settings', async() => {
    const results = await Promise.allSettled([save({}), save({})]);
    expect(results.map(item => item.status)).toEqual(['fulfilled', 'rejected']);
    const current = structuredClone(settings().workerBindings.luna);
    await expect(save({ expectedRevision: current.revision, expectedToken: current.editToken, candidates: [{ ...candidates[0], effort: 'ultra' }] })).rejects.toThrow('effort supported');
    expect(settings().workerBindings.luna).toEqual(current);
  });
});

describe('owner edit interleaved with agent registration', () => {
  const yBinding = { editToken: 'y-token', agentId: 'yarrow-id', revision: 1, connections: { codex: 'subscription-id' }, candidates };

  it('keeps agent Y binding that registered while owner edit of X was validating', async() => {
    const release = hold();
    const ownerEdit = save({});
    await flush();
    expect(await withWorkerBindingWrite(() => router.addWorkerBindingIfAbsent('yarrow', yBinding))).toBe(true);
    release(); await ownerEdit;
    expect(settings().workerBindings.yarrow).toEqual(yBinding);
    expect(settings().workerBindings.luna).toMatchObject({ agentId: 'luna-id', revision: 1, candidates });
    expect(settings().workerBindings.sonnet.agentId).toBe('sonnet-id');
  });

  it('does not resurrect agent Y binding that rolled back while owner edit of X was validating', async() => {
    await withWorkerBindingWrite(() => router.addWorkerBindingIfAbsent('yarrow', yBinding));
    const release = hold();
    const ownerEdit = save({});
    await flush();
    expect(await withWorkerBindingWrite(() => router.removeWorkerBindingIfOwned('yarrow', 'yarrow-id'))).toBe(true);
    release(); await ownerEdit;
    expect(settings().workerBindings.yarrow).toBeUndefined();
    expect(settings().workerBindings.luna.agentId).toBe('luna-id');
    // The slug is free again for its next exact registration.
    expect(await withWorkerBindingWrite(() => router.addWorkerBindingIfAbsent('yarrow', { ...yBinding, agentId: 'yarrow-2' }))).toBe(true);
  });

  it('compares the opened revision at write time, not at validation start', async() => {
    await save({}); const opened = structuredClone(settings().workerBindings.luna);
    const release = hold();
    const staleEdit = save({ expectedRevision: opened.revision, expectedToken: opened.editToken });
    await flush();
    // Another path removes and re-adds X between validation and the write.
    await withWorkerBindingWrite(() => router.removeWorkerBindingIfOwned('luna', 'luna-id'));
    await withWorkerBindingWrite(() => router.addWorkerBindingIfAbsent('luna', { ...yBinding, editToken: 'fresh', agentId: 'luna-id' }));
    release();
    await expect(staleEdit).rejects.toThrow('changed elsewhere');
    expect(settings().workerBindings.luna.editToken).toBe('fresh');
  });

  it('refuses a direct settings write outside the owner write scope', async() => {
    await expect(router.replaceWorkerBinding('luna', 'luna-id', { token: '', revision: 0 }, { editToken: 't', connections: {}, candidates })).rejects.toThrow('only be changed in AI Models');
    expect(settings().workerBindings.luna).toBeUndefined();
  });

  it('refuses a stale save for a deleted agent X after new agent Y reused the slug and got its own mapping', async() => {
    const release = hold();
    const staleSave = save({});
    await flush();
    // X is deleted in Studio; Y is created with the same slug and its exact pinned model.
    const yNew = { editToken: 'y-new', agentId: 'luna-y', revision: 1, connections: { codex: 'subscription-id' }, candidates };
    expect(await withWorkerBindingWrite(() => router.addWorkerBindingIfAbsent('luna', yNew))).toBe(true);
    release();
    await expect(staleSave).rejects.toThrow('changed elsewhere');
    expect(settings().workerBindings.luna).toEqual(yNew);
  });

  it('refuses a stale unpin for a deleted agent X after new agent Y reused the slug', async() => {
    const yNew = { editToken: 'y-new', agentId: 'luna-y', revision: 1, connections: { codex: 'subscription-id' }, candidates };
    let unblock!: () => void; const blocked = new Promise<void>(resolve => { unblock = resolve });
    // Hold the router write queue: Y's registration is queued first, X's stale unpin (opened with no mapping) after it.
    const queueHold = withWorkerBindingWrite(() => (router as any).serializeWrite(() => blocked));
    const yWrite = withWorkerBindingWrite(() => router.addWorkerBindingIfAbsent('luna', yNew));
    const staleUnpin = save({ candidates: null });
    await flush(); await flush();
    unblock(); await queueHold;
    expect(await yWrite).toBe(true);
    await expect(staleUnpin).rejects.toThrow('changed elsewhere');
    expect(settings().workerBindings.luna).toEqual(yNew);
  });

  it('still lets the current agent owner replace an orphaned mapping left by a deleted agent', async() => {
    const orphan = { editToken: 'orphan', agentId: 'deleted-agent', revision: 5, candidates };
    await withWorkerBindingWrite(() => router.set({ workerBindings: { ...settings().workerBindings, luna: orphan } }));
    await save({});
    expect(settings().workerBindings.luna).toMatchObject({ agentId: 'luna-id', revision: 1, connections: { codex: 'subscription-id' } });
  });
});
