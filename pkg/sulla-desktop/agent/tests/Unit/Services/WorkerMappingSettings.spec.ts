// SPDX-License-Identifier: GPL-2.0-or-later
/* Async mocks mirror production interfaces without network or database effects. */
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { ModelRouter, recommendedState } from '../../../languagemodels/modelRouter';
vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { codex: {}, 'claude-code': {} } }));

const store = new Map<string, any>();
beforeEach(() => {
  store.clear();
  vi.spyOn(SullaSettingsModel, 'get').mockImplementation(async(key, fallback) => structuredClone(store.get(key) ?? fallback));
  vi.spyOn(SullaSettingsModel, 'set').mockImplementation(async(key, value) => { store.set(key, structuredClone(value)) });
});
function router() { return new ModelRouter(() => ({ getAvailableProviders: async() => [{ id: 'codex', connected: true }], getModelsForProvider: async() => [{ id: 'luna', efforts: [{ id: 'max' }] }] })) }
const bindings = { luna: { agentId: 'luna-id', revision: 1, candidates: [{ provider: 'codex', model: 'luna', effort: 'max' }] }, sonnet: { agentId: 'sonnet-id', revision: 2, candidates: [{ provider: 'claude-code', model: 'sonnet' }] } };
describe('worker mapping settings compatibility', () => {
  it('preserves sibling mappings through unrelated writes, reset, catalog refresh and reload', async() => {
    store.set('modelRouting', { ...recommendedState(), workerBindings: bindings });
    const subject = router();
    await subject.set({ neverUse: [] }); await subject.reset({ section: 'classes', class: 'fast' }); await subject.reset({ section: 'agents' });
    await subject.refreshCatalog();
    expect((await router().getEditableState()).workerBindings).toEqual(bindings);
    expect((await subject.getEditableState()).classes.fast).not.toEqual(bindings.luna.candidates);
  });
  it('serializes unrelated saves without losing a worker mapping', async() => {
    store.set('modelRouting', recommendedState()); const subject = router();
    await Promise.all([subject.set({ workerBindings: bindings }), subject.set({ agentsList: [] })]);
    expect((await subject.getEditableState()).workerBindings).toEqual(bindings);
    expect((await subject.getEditableState()).agentsList).toEqual([]);
  });
});
