// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  containerVault: false,
  runtimeConfig: vi.fn(),
  executionContext: vi.fn(),
  providerFetch: vi.fn(),
}));
vi.mock('@pkg/vault-broker', () => ({ usesContainerVaultAuthority: () => f.containerVault }));
vi.mock('../../../languagemodels/providerBroker', () => ({
  loadProviderRuntimeConfig: f.runtimeConfig,
  issueServiceProviderExecutionContext: f.executionContext,
  providerFetch: f.providerFetch,
}));
vi.mock('../../../services/IntegrationService', () => ({ getIntegrationService: () => ({
  getActiveAccountId: async() => 'kimi-owner',
  getFormValues: async() => [{ property: 'region', value: 'international' }],
}) }));
vi.mock('../../../integrations/catalog', () => ({ integrations: { kimi: {
  id: 'kimi', category: 'AI Infrastructure', properties: [{ key: 'model', selectBoxId: 'kimi_models' }],
} } }));
vi.mock('../../../integrations/select_box', () => ({ getSelectBoxProvider: vi.fn() }));
vi.mock('../../../tools/models/shared', () => ({ getCliStatus: vi.fn() }));
vi.mock('@pkg/main/firstRun/pendingCredentials', () => ({ hasPendingCredential: () => false }));
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: vi.fn() }));
vi.mock('../../../services/ServiceLifecycleManager', () => ({ getServiceLifecycleManager: () => ({ on: vi.fn() }) }));
vi.mock('../../../database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));

import { ModelDiscoveryService } from '../../../languagemodels/ModelDiscoveryService';
import { getModelProviderService } from '../../../services/ModelProviderService';

beforeEach(() => {
  f.containerVault = false;
  f.runtimeConfig.mockReset();
  f.executionContext.mockReset();
  f.providerFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('live model discovery for AI Models refresh', () => {
  it('does not turn an empty live response into a fresh catalog or reuse the ordinary fallback cache', async() => {
    const service = new ModelDiscoveryService();
    const fetch = vi.fn(async() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const ordinary = await service.fetchModelsForProvider('deepseek', 'key', { liveOnly: false });
    expect(ordinary.length).toBeGreaterThan(0);
    await expect(service.fetchModelsForProvider('deepseek', 'key', { liveOnly: true })).resolves.toEqual([]);
    await expect(service.fetchModelsForProvider('deepseek', 'key', { liveOnly: false })).resolves.toEqual(ordinary);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not fall back to static or expired cached models after a live discovery error', async() => {
    const service = new ModelDiscoveryService();
    vi.stubGlobal('fetch', vi.fn(async() => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const ordinary = await service.fetchModelsForProvider('cohere', 'key', { liveOnly: false });
    expect(ordinary.length).toBeGreaterThan(0);

    vi.stubGlobal('fetch', vi.fn(async() => { throw new Error('offline fixture'); }));
    await expect(service.fetchModelsForProvider('cohere', 'key', { liveOnly: true })).resolves.toEqual([]);
  });

  it('uses the requested connected account and live list for secure-vault metadata discovery', async() => {
    f.containerVault = true;
    f.runtimeConfig.mockResolvedValue({ accountId: 'kimi-owner', values: { region: 'international' } });
    f.executionContext.mockResolvedValue({ credential_scope: { integration_id: 'kimi', account_id: 'kimi-owner' } });
    f.providerFetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'moonshot-new', name: 'Moonshot New' }] }), { status: 200 }));
    const { modelDiscoveryService } = await import('../../../languagemodels/ModelDiscoveryService');
    modelDiscoveryService.clearCache();
    const model = await getModelProviderService().getModelsForProvider('kimi', { liveOnly: true });
    expect(model).toEqual([{ id: 'moonshot-new', name: 'moonshot-new', description: undefined, selectionMode: 'exact' }]);
    expect(f.runtimeConfig).toHaveBeenCalledWith('kimi', 'kimi-owner');
    expect(f.providerFetch.mock.calls[0][4]).toMatchObject({ operation: 'provider.discovery', streaming: false });
  });
});
