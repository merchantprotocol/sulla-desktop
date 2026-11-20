// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
const network = vi.hoisted(() => ({ providers: [] as unknown[], offline: false }));
vi.mock('../../../languagemodels/sharedModelCatalog', async(importOriginal) => {
  const actual = await importOriginal<typeof import('../../../languagemodels/sharedModelCatalog')>();
  return { ...actual, sharedModelCatalog: { listModels: async(provider: string) => {
    const client = new actual.SharedModelCatalogClient(async() => {
      if (network.offline) throw new Error('offline');
      return new Response(JSON.stringify({ schemaVersion: 1, providers: network.providers }));
    }, () => 1, async() => null, async() => undefined);
    return client.listModels(provider);
  } } };
});
import { listCodexModels } from '../../../languagemodels/codexModelCatalog';

beforeEach(() => { network.providers = []; network.offline = false; });
describe('codex Cloud authority', () => {
  it('uses exact Cloud metadata without promoting API records or private account discovery', async() => {
    // risk: transport identity and unsupported reasoning effort
    network.providers = [
      { id: 'openai', name: 'API', models: [{ id: 'api-only', name: 'API only' }] },
      { id: 'codex', name: 'CLI', models: [{ id: 'official-cli-model', name: 'CLI model', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', selectionMode: 'exact' }] },
    ];
    expect(await listCodexModels()).toEqual([{ id: 'official-cli-model', name: 'CLI model', efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low', selectionMode: 'exact' }]);
  });
  it('reports unavailable without adding an Auto sentinel on first-start failure or missing provider', async() => {
    // risk: silent downgrade / account default substitution
    network.offline = true;
    expect(await listCodexModels()).toEqual([]);
    network.offline = false;
    network.providers = [{ id: 'openai', name: 'API', models: [{ id: 'api-only', name: 'API only' }] }];
    expect(await listCodexModels()).toEqual([]);
  });
});
