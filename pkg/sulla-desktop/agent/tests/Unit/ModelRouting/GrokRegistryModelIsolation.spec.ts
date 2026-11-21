// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  defaultModel: 'grok-4.5',
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
}));

vi.mock('../../../../vault-broker', () => ({
  usesContainerVaultAuthority: () => false,
  configuredVaultBrokerProvider: {},
}));
// Tier resolution imports the Claude guest bridge, which pulls in Electron's
// main-process MCP host. Grok routing does not use that bridge.
vi.mock('../../../languagemodels/guestClaudeBridge', () => ({ createGuestClaudeAuth: vi.fn() }));
vi.mock('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({
    getFormValues: async() => [
      { property: 'model', value: fixture.defaultModel },
      { property: 'api_key', value: 'synthetic-metered-key' },
    ],
    getActiveAccountId: async() => 'default',
    getOAuthAccessToken: async() => 'synthetic-oauth-token',
  }),
}));
vi.mock('../../../services/ModelProviderService', () => ({
  getModelProviderService: () => ({
    getModelsForProvider: async() => [{ id: 'grok-4.6' }, { id: 'grok-4.7' }],
  }),
}));
vi.mock('../../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: async(key: string, fallback: unknown) => key === 'remoteRetryCount' ? 0 : fallback },
}));
vi.mock('../../../database/models/MeterableUsageModel', () => ({ MeterableUsageModel: {} }));
vi.mock('@pkg/main/cloud/byoUsageSync', () => ({ ByoUsageSync: {} }));
vi.mock('@pkg/main/firstRun/pendingCredentials', () => ({ getPendingCredential: () => undefined }));
vi.mock('../../../tools/models/shared', () => ({ getCliStatus: vi.fn() }));
vi.mock('@pkg/backend/providerCliUpdates', () => ({ getWorkerImageCliVersion: vi.fn() }));
vi.mock('@pkg/utils/firstRunTraceSink', () => ({ firstRunTrace: vi.fn() }));

import { GrokService, resetGrokService } from '../../../languagemodels/GrokService';
import { LLMRegistryImpl } from '../../../languagemodels/index';

beforeEach(() => {
  fixture.defaultModel = 'grok-4.5';
  fixture.fetch.mockReset().mockImplementation(async(url, request) => {
    if (url === 'https://cli-chat-proxy.grok.com/v1/models' && (request.method ?? 'GET') === 'GET') {
      return Response.json({ data: [{ id: 'grok-4.5' }] });
    }
    if (url === 'https://cli-chat-proxy.grok.com/v1/responses' && request.method === 'POST') {
      return Response.json({ output_text: 'ok', status: 'completed' });
    }
    throw new Error(`Unexpected Grok request: ${ request.method ?? 'GET' } ${ url }`);
  });
  vi.stubGlobal('fetch', fixture.fetch);
  resetGrokService();
});

afterEach(() => {
  resetGrokService();
  vi.unstubAllGlobals();
});

describe('Grok model instance isolation in the LLM registry', () => {
  it('dispatches 4.6 → 4.7 → cached 4.6 without changing the prior or default service', async() => {
    // risk: the wrong model receives a request on the owner's subscription
    const registry = new LLMRegistryImpl();
    const defaultService = await registry.getServiceByProvider('grok');
    const first = await registry.getServiceByProvider('grok', 'grok-4.6');
    const messages = [{ role: 'user', content: 'Hello' }] as const;
    await first.chat([...messages]);
    const second = await registry.getServiceByProvider('grok', 'grok-4.7');
    await second.chat([...messages]);
    const cached = await registry.getServiceByProvider('grok', 'grok-4.6');
    await cached.chat([...messages]);

    expect(fixture.fetch.mock.calls.map(([url, request]) => {
      const headers = new Headers(request.headers);
      return [url, JSON.parse(String(request.body)).model, headers.get('x-grok-model-override'), headers.get('authorization')];
    })).toEqual(['grok-4.6', 'grok-4.7', 'grok-4.6'].map(model => [
      'https://cli-chat-proxy.grok.com/v1/responses', model, model, 'Bearer synthetic-oauth-token',
    ]));
    expect(first).toBeInstanceOf(GrokService);
    expect(cached).toBe(first);
    expect(second).not.toBe(first);
    expect(defaultService).not.toBe(first);
    expect(defaultService).not.toBe(second);
    expect(await registry.getServiceByProvider('grok')).toBe(defaultService);
    expect([first.getModel(), second.getModel(), defaultService.getModel()]).toEqual(['grok-4.6', 'grok-4.7', 'grok-4.5']);
  });

  it('uses a validated explicit model even when the default would need separate discovery', async() => {
    // risk: a valid pinned model fails due to an unrelated default lookup
    fixture.defaultModel = '';
    const registry = new LLMRegistryImpl();
    const service = await registry.getServiceByProvider('grok', 'grok-4.7');
    expect(service.getModel()).toBe('grok-4.7');
    expect(fixture.fetch).not.toHaveBeenCalled();

    const defaultService = await registry.getServiceByProvider('grok');
    expect(defaultService.getModel()).toBe('grok-4.5');
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.fetch).toHaveBeenCalledWith('https://cli-chat-proxy.grok.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-oauth-token' }),
    }));
  });

  it('rejects an unavailable explicit model rather than defaulting', async() => {
    // risk: silently overriding the owner’s explicit model pin
    const registry = new LLMRegistryImpl();
    await expect(registry.getServiceByProvider('grok', 'missing-model')).rejects.toThrow('unavailable in the validated catalog');
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});
