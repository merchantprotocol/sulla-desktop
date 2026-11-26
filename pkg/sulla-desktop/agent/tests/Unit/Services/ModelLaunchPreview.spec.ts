// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaunchPreviewSession } from '../../../services/ModelLaunchPreview';
import { workerModelRouting } from '../../../services/WorkerModelRouting';
import { modelRouter, recommendedState } from '../../../languagemodels/modelRouter';
import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { agentDefinitionService } from '../../../services/AgentDefinitionService';
import type { RoutingProviderInfo } from '../../../languagemodels/modelRoutingTypes';

// Preview reads model metadata; no Electron process or native API is involved.
vi.mock('electron', () => ({ app: { isPackaged: false }, safeStorage: {} }));

const a = { provider: 'codex', model: 'test-a', effort: 'high' };
const b = { provider: 'grok', model: 'test-b' };
const c = { provider: 'codex', model: 'test-c', effort: 'low' };
const accounts = { codex: 'a-test', grok: 'b-test' };
function setup() {
  const settings = recommendedState();
  const providers = ['codex', 'grok'].map(id => ({ id, connected: true, status: 'ready',
    models: [a,b,c].filter(row => row.provider === id).map(row => ({ id: row.model, efforts: [{ id: 'high' }, { id: 'low' }] })) })) as RoutingProviderInfo[];
  settings.workerBindings = { tester: { revision: 1, agentId: 'def', candidates: [a,c,b], connections: accounts,
    modelTiers: { version: 1, tiers: [{ candidates: [a,c] }, { candidates: [b] }] } } };
  vi.spyOn(modelRouter, 'getEditableState').mockResolvedValue(settings);
  vi.spyOn(modelRouter, 'providerInfo').mockResolvedValue(providers);
  vi.spyOn(agentDefinitionService, 'findBySlug').mockResolvedValue({ id: 'def', slug: 'tester' } as any);
  const read = vi.spyOn(workerModelRouting, 'subscriptionConnections').mockResolvedValue(accounts);
  const write = vi.spyOn(SullaSettingsModel, 'set').mockImplementation(async() => { throw new Error('Unexpected settings write') });
  return { settings, providers, read, write, session: new LaunchPreviewSession(providers, settings) };
}
afterEach(() => vi.restoreAllMocks());
describe('preview of the next launch', () => {
  it('matches execution order after provider backoff and never-use, without writing or launching', async() => {
    const { session, providers, settings, write, read } = setup();
    providers[0].status = 'cooling';
    settings.neverUse = [{ ...a, effort: 'any' }];
    const before = JSON.stringify(settings);
    const result = await session.preview({ slug: 'tester', agentId: 'def' });
    expect(result).toMatchObject({ status: 'ready', candidates: [b,c] });
    expect(result.reason).toMatch(/backoff.*1 unavailable/);
    await session.preview({ slug: 'tester', agentId: 'def' });
    expect(read).toHaveBeenCalledTimes(2);
    const actual = await workerModelRouting.newRoute('tester');
    expect(await workerModelRouting.resolveRoute(actual!)).toEqual(result.candidates);
    expect(JSON.stringify(settings)).toBe(before);
    expect(write).not.toHaveBeenCalled();
  });
  it('previews an unsaved grouped draft without writing a binding and restores live inheritance', async() => {
    const { session, settings, write } = setup();
    const original = JSON.stringify(settings.workerBindings);
    const draft = { version: 1 as const, tiers: [{ candidates: [b,c] }, { candidates: [a] }], crossCompanyFallback: false };
    const result = await session.preview({ slug: 'tester', agentId: 'def', modelTiers: draft });
    expect(result).toMatchObject({ status: 'ready', candidates: [b], reason: expect.stringContaining('Unsaved model tiers') });
    expect(result.skipped?.map(item => item.reason)).toEqual(['different company from Tier 1','different company from Tier 1']);
    const resolve = vi.spyOn(modelRouter, 'resolve').mockResolvedValue([c]);
    const inherited = await session.preview({ slug: 'tester', agentId: 'def', modelTiers: null, choice: { mode: 'class', class: 'coding' } });
    expect(inherited).toMatchObject({ status: 'ready', candidates: [c], reason: expect.stringContaining('coding class') });
    expect(resolve).toHaveBeenCalledWith('agents', { mode: 'class', class: 'coding' }, settings);
    expect(JSON.stringify(settings.workerBindings)).toBe(original);
    expect(write).not.toHaveBeenCalled();
  });
  it('identifies an empty class and the optional first model from the graph’s own slot', async() => {
    const { session, settings } = setup();
    const resolve = vi.spyOn(modelRouter, 'resolve').mockResolvedValueOnce([]).mockResolvedValueOnce([b,c]);
    const result = await session.preview({ choice: { mode: 'class', class: 'fast' } }, { slot: 'subconscious' });
    expect(resolve).toHaveBeenLastCalledWith('subconscious', { mode: 'list' }, settings);
    expect(result).toMatchObject({ status: 'deferred', candidates: [b], reason: expect.stringContaining('shared list') });
  });
  it('keeps a missing catalog waiting, a revoked account blocked and never borrows a replacement subscription', async() => {
    const { session, providers } = setup();
    providers.forEach(provider => { provider.models = [] });
    expect((await session.preview({ slug: 'tester', agentId: 'def' })).status).toBe('waiting');
    const next = setup();
    next.read.mockResolvedValue({ codex: 'replacement', grok: 'replacement' });
    expect(await next.session.preview({ slug: 'tester', agentId: 'def' })).toMatchObject({ status: 'blocked', candidates: [] });
  });
});
