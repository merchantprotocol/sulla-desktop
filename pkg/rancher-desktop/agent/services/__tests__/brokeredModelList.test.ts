import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Fake broker + account metadata. No real credential exists anywhere in this
// test: the broker is the only thing that would ever attach one.
const executeMock: any = jest.fn();
const issueContextMock: any = jest.fn(async(input: any) => ({
  v: 1, agent_id: input.agentId, pod_id: input.podId, credential_scope: input.credentialScope,
  thread_id: input.threadId, job_id: input.jobId,
}));
let accounts: any[] = [];

class FakeVaultBrokerError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message) }
}

jest.unstable_mockModule('../../../vault-broker', () => ({
  usesContainerVaultAuthority: () => process.env.SULLA_VAULT_MODE !== 'server',
  issueLocalBrokerContext:     issueContextMock,
  requireConfiguredCredentialBroker: () => ({
    requestFor: (ctx: any, request: any) => ({ ...request, claims: ctx }),
    execute:    executeMock,
  }),
  VaultBrokerError: FakeVaultBrokerError,
}));
jest.unstable_mockModule('@pkg/main/deviceIdentity', () => ({ getDesktopDeviceId: async() => 'device-test' }));
jest.unstable_mockModule('../IntegrationService', () => ({
  getIntegrationService: () => ({
    getAccounts:           async(id: string) => accounts.filter(a => a.integration_id === id),
    getActiveAccountId:    async(id: string) => accounts.find(a => a.integration_id === id && a.active)?.account_id ?? 'default',
    // Container vault: metadata only, never a credential.
    getFormValues:         async() => (process.env.SULLA_VAULT_MODE === 'server' ? [{ property: 'api_key', value: 'legacy-test-key' }] : []),
    isAnyAccountConnected: async(id: string) => accounts.some(a => a.integration_id === id && a.connected),
  }),
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: async(_k: string, d: unknown) => d, set: async() => undefined },
}));
jest.unstable_mockModule('../../tools/models/shared', () => ({
  getCliStatus: async() => ({ required: false, installed: true }),
}));

const account = (integration_id: string, account_id: string, extra: Record<string, unknown> = {}) =>
  ({ integration_id, account_id, label: account_id, active: false, connected: true, ...extra });
const ok = (body: unknown) => ({ status: 200, headers: {}, body });

const {
  clearBrokeredModelListCache, fetchBrokeredModelList, listProviderModelsBrokered, resolveModelListAccount,
} = await import('../brokeredModelList');

let warnSpy: any;
beforeEach(() => {
  delete process.env.SULLA_VAULT_MODE;
  clearBrokeredModelListCache();
  executeMock.mockReset();
  issueContextMock.mockClear();
  accounts = [];
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
  delete process.env.SULLA_VAULT_MODE;
});

describe('fetchBrokeredModelList', () => {
  const request = {
    providerId: 'openai',
    accountId:  'default',
    url:        'https://api.openai.com/v1/models',
    injections: [{ field: 'api_key', target: 'header' as const, name: 'authorization', scheme: 'Bearer' as const }],
    headers:    { Authorization: 'Bearer should-be-stripped', 'x-api-key': 'strip', accept: 'application/json' },
  };

  it('sends a scoped GET provider.models request and returns the body', async() => {
    executeMock.mockResolvedValue(ok({ data: [{ id: 'gpt-x' }] }));
    await expect(fetchBrokeredModelList(request)).resolves.toEqual({ data: [{ id: 'gpt-x' }] });

    const sent = executeMock.mock.calls[0][0];
    expect(sent.operation).toBe('provider.models');
    expect(sent.method).toBe('GET');
    expect(sent.ref).toEqual({ integrationId: 'openai', accountId: 'default' });
    expect(sent.injections).toEqual(request.injections);
    expect(sent.headers).toEqual({ accept: 'application/json' }); // credential headers never forwarded
    expect(sent.claims.agent_id).toBe('sulla');
    expect(sent.claims.pod_id).toMatch(/^sulla-model-list-[0-9a-f-]{36}$/);
    expect(sent.claims.device_id).toBe('device-test');
    expect(sent.claims.credential_scope).toEqual({ integration_id: 'openai', account_id: 'default' });
  });

  it('returns null with one warn on upstream 401', async() => {
    executeMock.mockResolvedValue({ status: 401, headers: {}, body: { error: 'unauthorized' } });
    await expect(fetchBrokeredModelList(request)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('upstream HTTP 401');
  });

  it('returns null when the vault denies the operation', async() => {
    executeMock.mockRejectedValue(new FakeVaultBrokerError('policy_denied', 'Registered operation policy denied the request', 403));
    await expect(fetchBrokeredModelList(request)).resolves.toBeNull();
    expect(String(warnSpy.mock.calls[0][0])).toContain('policy_denied');
  });

  it('returns null on network failure', async() => {
    executeMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchBrokeredModelList(request)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('serves repeat calls from the cache (success and failure)', async() => {
    executeMock.mockResolvedValue(ok({ data: [] }));
    await fetchBrokeredModelList(request);
    await fetchBrokeredModelList(request);
    await Promise.all([fetchBrokeredModelList(request), fetchBrokeredModelList(request)]);
    expect(executeMock).toHaveBeenCalledTimes(1);

    executeMock.mockReset().mockRejectedValue(new Error('down'));
    const other = { ...request, accountId: 'second' };
    await fetchBrokeredModelList(other);
    await fetchBrokeredModelList(other);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveModelListAccount', () => {
  it('prefers the requested, then active, then any connected account', async() => {
    accounts = [account('anthropic', 'a'), account('anthropic', 'b', { active: true }), account('anthropic', 'c', { connected: false })];
    expect((await resolveModelListAccount('anthropic', 'a'))?.account_id).toBe('a');
    expect((await resolveModelListAccount('anthropic', 'c'))?.account_id).toBe('b');
    expect((await resolveModelListAccount('anthropic'))?.account_id).toBe('b');
    accounts = [account('anthropic', 'x', { active: true, connected: false }), account('anthropic', 'y')];
    expect((await resolveModelListAccount('anthropic'))?.account_id).toBe('y');
    accounts = [account('anthropic', 'x', { active: true, connected: false })];
    expect(await resolveModelListAccount('anthropic')).toBeNull();
  });

  it('makes no broker call when nothing is connected', async() => {
    await expect(listProviderModelsBrokered('openai')).resolves.toEqual({ body: null, lane: null });
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('select-box providers in container-vault mode', () => {
  it('Anthropic lists live models through the broker, static list on failure', async() => {
    accounts = [account('anthropic', 'default', { active: true })];
    const { AnthropicModels } = await import('../../integrations/select_box/AnthropicModels');
    executeMock.mockResolvedValue(ok({ data: [{ id: 'claude-live-1', display_name: 'Live 1' }] }));
    const live = await new AnthropicModels().getOptions({ integrationId: 'anthropic', accountId: 'default', formValues: {} });
    expect(live).toEqual([{ value: 'claude-live-1', label: 'Live 1' }]);
    const sent = executeMock.mock.calls[0][0];
    expect(sent.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(sent.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent.injections).toEqual([{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }]);

    clearBrokeredModelListCache();
    executeMock.mockReset().mockRejectedValue(new Error('down'));
    const fallback = await new AnthropicModels().getOptions({ integrationId: 'anthropic', accountId: 'default', formValues: {} });
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.some(o => o.value === 'claude-opus-5-5')).toBe(true);
  });

  it('Grok OAuth account uses the subscription proxy lane with grok-cli headers', async() => {
    accounts = [account('grok', 'default', { active: true }), account('grok', 'oauth')];
    const { GrokModels } = await import('../../integrations/select_box/GrokModels');
    executeMock.mockResolvedValue(ok({ data: [{ id: 'grok-sub-1' }] }));
    const live = await new GrokModels().getOptions({ integrationId: 'grok', accountId: 'default', formValues: {} });
    expect(live.map(o => o.value)).toEqual(['grok-sub-1']);
    const sent = executeMock.mock.calls[0][0];
    expect(sent.url).toBe('https://cli-chat-proxy.grok.com/v1/models');
    expect(sent.ref.accountId).toBe('oauth');
    expect(sent.injections).toEqual([{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }]);
    expect(sent.headers['x-xai-token-auth']).toBe('xai-grok-cli');

    clearBrokeredModelListCache();
    executeMock.mockReset().mockResolvedValue({ status: 403, headers: {}, body: null });
    const fallback = await new GrokModels().getOptions({ integrationId: 'grok', accountId: 'default', formValues: {} });
    expect(fallback.map(o => o.value)).toContain('grok-4.5'); // subscription-lane static list, not grok-3
  });

  it('Grok API-key account uses api.x.ai without grok-cli headers', async() => {
    accounts = [account('grok', 'default', { active: true })];
    const { GrokModels } = await import('../../integrations/select_box/GrokModels');
    executeMock.mockRejectedValue(new Error('down'));
    const fallback = await new GrokModels().getOptions({ integrationId: 'grok', accountId: 'default', formValues: {} });
    const sent = executeMock.mock.calls[0][0];
    expect(sent.url).toBe('https://api.x.ai/v1/models');
    expect(sent.injections[0].field).toBe('api_key');
    expect(sent.headers['x-xai-token-auth']).toBeUndefined();
    expect(fallback.map(o => o.value)).toContain('grok-3');
  });

  it('OpenAI lists sorted live models; empty on failure (it has no static catalog)', async() => {
    accounts = [account('openai', 'default', { active: true })];
    const { OpenAIModels } = await import('../../integrations/select_box/OpenAIModels');
    executeMock.mockResolvedValue(ok({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }));
    const live = await new OpenAIModels().getOptions({ integrationId: 'openai', accountId: 'default', formValues: {} });
    expect(live.map(o => o.value)).toEqual(['gpt-a', 'gpt-b']);
    clearBrokeredModelListCache();
    executeMock.mockReset().mockRejectedValue(new Error('down'));
    await expect(new OpenAIModels().getOptions({ integrationId: 'openai', accountId: 'default', formValues: {} })).resolves.toEqual([]);
  });
});

describe('getModelsForProvider', () => {
  it('container mode: anthropic and claude-code use the broker; claude-code falls back to Auto + static', async() => {
    accounts = [account('anthropic', 'default', { active: true }), account('claude-code', 'oauth', { active: true })];
    executeMock.mockImplementation(async(req: any) => (req.ref.integrationId === 'anthropic'
      ? ok({ data: [{ id: 'claude-live-2', display_name: 'Live 2' }] })
      : { status: 400, headers: {}, body: null }));
    const { getModelProviderService } = await import('../ModelProviderService');
    const service = getModelProviderService();

    const anthropic = await service.getModelsForProvider('anthropic');
    expect(anthropic.map(m => m.id)).toEqual(['claude-live-2']);

    const claude = await service.getModelsForProvider('claude-code');
    const claudeReq = executeMock.mock.calls.find((c: any) => c[0].ref.integrationId === 'claude-code')[0];
    expect(claudeReq.injections).toEqual([{ field: 'oauth_token', target: 'header', name: 'authorization', scheme: 'Bearer' }]);
    expect(claudeReq.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(claude[0].id).toBe('claude-code'); // Auto sentinel
    expect(claude.length).toBeGreaterThan(1); // static fallback keeps the group non-empty
  });

  it('legacy server mode keeps the direct fetch and never calls the broker', async() => {
    process.env.SULLA_VAULT_MODE = 'server';
    const fetchMock: any = jest.fn(async() => ({ ok: true, status: 200, json: async() => ({ data: [{ id: 'claude-direct' }] }) }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const { getModelProviderService } = await import('../ModelProviderService');
      const models = await getModelProviderService().getModelsForProvider('anthropic');
      expect(models.map(m => m.id)).toEqual(['claude-direct']);
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models');
      expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('legacy-test-key');
      expect(executeMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
