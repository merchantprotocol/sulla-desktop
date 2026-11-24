// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../../vault-broker', () => ({
  usesContainerVaultAuthority: () => false,
  configuredVaultBrokerProvider: { requireConfiguredCredentialBroker: vi.fn() },
}));
vi.mock('../../../languagemodels/failures', () => ({ providerFailureFromHttp: vi.fn() }));

import { providerFetch } from '../../../languagemodels/providerBroker';

const state: any = { metadata: { workerModelRoute: { selected: 0, connections: { grok: 'oauth' }, candidates: [{ provider: 'grok', model: 'grok-4.6' }] } } };
const context: any = { credential_scope: { integration_id: 'grok', account_id: 'oauth' } };
const url = 'https://cli-chat-proxy.grok.com/v1/responses';
function request(model = 'grok-4.6') { return { method: 'POST', body: JSON.stringify({ model }) } }

beforeEach(() => {
  mocks.fetch.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('mapped Grok HTTP requests', () => {
  it.each([false, true])('checks exact OAuth account, subscription host and model for streaming=%s', async streaming => {
    const response = await providerFetch('grok', url, request(), context, {
      streaming, state, model: 'grok-4.6', authMode: 'oauth',
    });
    expect(response.ok).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { account: 'api-key-account', authMode: 'oauth', model: 'grok-4.6', target: url },
    { account: 'oauth', authMode: 'api-key', model: 'grok-4.6', target: url },
    { account: 'oauth', authMode: 'oauth', model: 'grok-4.5', target: url },
    { account: 'oauth', authMode: 'oauth', model: 'grok-4.6', target: 'https://api.x.ai/v1/responses' },
  ])('blocks a changed account, auth lane, model, or billing endpoint before fetch', async invalid => {
    await expect(providerFetch('grok', invalid.target, request(invalid.model), {
      credential_scope: { integration_id: 'grok', account_id: invalid.account },
    } as any, { streaming: true, state, model: invalid.model, authMode: invalid.authMode as any })).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects a request body whose model differs from the resolved model', async() => {
    await expect(providerFetch('grok', url, request('grok-4.5'), context, {
      streaming: false, state, model: 'grok-4.6', authMode: 'oauth',
    })).rejects.toThrow('does not match');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('checks a Grok launch override without inventing a worker route', async() => {
    // risk: an explicit Grok override bypasses the saved-mapping OAuth subscription guard
    const overrideState: any = { metadata: { modelOverride: { provider: 'grok', model: 'grok-4.6', connections: { grok: 'oauth' } } } };
    await expect(providerFetch('grok', url, request(), context, {
      streaming: true, state: overrideState, model: 'grok-4.6', authMode: 'api-key',
    })).rejects.toThrow('launch override');
    expect(overrideState.metadata).not.toHaveProperty('workerModelRoute');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
