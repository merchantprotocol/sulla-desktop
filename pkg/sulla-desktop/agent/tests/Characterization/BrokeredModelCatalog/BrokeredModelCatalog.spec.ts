// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IntegrationAccount } from '../../../services/IntegrationService';

const boundary = vi.hoisted(() => ({
  accounts: new Map<string, IntegrationAccount[]>(),
  metadata: new Map<string, Array<{ property: string; value: string }>>(),
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({
    getAccounts: async(providerId: string) => boundary.accounts.get(providerId) ?? [],
    getMetadataValues: async(providerId: string, accountId: string) => boundary.metadata.get(`${providerId}:${accountId}`) ?? [],
  }),
}));

vi.mock('../../../../vault-broker', () => ({
  issueLocalBrokerContext: async(input: Record<string, unknown>) => ({ ...input, brokered: true }),
  requireConfiguredCredentialBroker: () => ({
    requestFor: (_context: unknown, request: Record<string, unknown>) => request,
    execute: async(request: Record<string, unknown>) => {
      boundary.requests.push(request);
      return { status: 200, body: { provider: (request.ref as { integrationId: string }).integrationId, models: ['synthetic-model'] } };
    },
  }),
}));

vi.mock('@pkg/main/deviceIdentity', () => ({ getDesktopDeviceId: async() => 'synthetic-device' }));

import {
  clearBrokeredModelListCache,
  listProviderModelsBrokered,
  resolveModelListAccount,
} from '../../../services/brokeredModelList';

const connected = (accountId: string, active = false): IntegrationAccount => ({
  integration_id: 'synthetic-provider',
  account_id: accountId,
  label: `Synthetic ${accountId}`,
  connected: true,
  active,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

describe('brokered model catalog characterization', () => {
  beforeEach(() => {
    boundary.accounts.clear();
    boundary.metadata.clear();
    boundary.requests.length = 0;
    clearBrokeredModelListCache();
  });

  it('pins account preference, active fallback, connected fallback, and no-account behavior', async() => {
    const first = connected('synthetic-first');
    const active = connected('synthetic-active', true);
    const preferred = connected('synthetic-preferred');
    const disconnected = { ...connected('synthetic-disconnected'), connected: false };

    expect(await resolveModelListAccount('openai', preferred.account_id, [first, active, preferred, disconnected])).toEqual(preferred);
    expect(await resolveModelListAccount('openai', 'missing', [first, active, disconnected])).toEqual(active);
    expect(await resolveModelListAccount('openai', 'missing', [first, disconnected])).toEqual(first);
    expect(await resolveModelListAccount('openai', undefined, [disconnected])).toBeNull();
  });

  it.each([
    {
      provider: 'anthropic', account: 'synthetic-anthropic-key', preferred: undefined,
      url: 'https://api.anthropic.com/v1/models?limit=1000',
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-workspace-id': 'synthetic-workspace', 'x-fixture': 'anthropic' },
      injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }], oauth: false,
    },
    {
      provider: 'claude-code', account: 'oauth', preferred: 'oauth',
      url: 'https://api.anthropic.com/v1/models?limit=1000',
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', 'x-fixture': 'claude-code' },
      injections: [{ field: 'oauth_token', target: 'header', name: 'authorization', scheme: 'Bearer' }], oauth: true,
    },
    {
      provider: 'claude-code', account: 'synthetic-claude-key', preferred: undefined,
      url: 'https://api.anthropic.com/v1/models?limit=1000',
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-workspace-id': 'synthetic-workspace', 'x-fixture': 'claude-code' },
      injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }], oauth: false,
    },
    {
      provider: 'openai', account: 'synthetic-openai-key', preferred: undefined,
      url: 'https://api.openai.com/v1/models', headers: { 'x-fixture': 'openai' },
      injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }], oauth: false,
    },
    {
      provider: 'grok', account: 'oauth', preferred: undefined,
      url: 'https://cli-chat-proxy.grok.com/v1/models', headers: { 'x-fixture': 'grok' },
      injections: [{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }], oauth: true,
    },
    {
      provider: 'grok', account: 'synthetic-grok-key', preferred: undefined,
      url: 'https://api.x.ai/v1/models', headers: { 'x-fixture': 'grok' },
      injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }], oauth: false,
    },
  ])('pins $provider/$account account, headers, request, lane, and result', async(fixture) => {
    const accounts = fixture.provider === 'grok' && fixture.account === 'oauth'
      ? [connected('synthetic-grok-key', true), connected('oauth')]
      : [connected(fixture.account, true)];
    boundary.accounts.set(fixture.provider, accounts);
    boundary.metadata.set(`${fixture.provider}:${fixture.account}`, [{ property: 'workspace_id', value: ' synthetic-workspace ' }]);

    const result = await listProviderModelsBrokered<{ provider: string; models: string[] }>(
      fixture.provider,
      fixture.preferred,
      lane => ({ 'x-fixture': fixture.provider, authorization: 'must-be-stripped', 'x-api-key': 'must-be-stripped' }),
    );

    expect(result).toEqual({
      body: { provider: fixture.provider, models: ['synthetic-model'] },
      lane: { url: fixture.url, injections: fixture.injections, headers: fixture.headers['anthropic-version']
        ? Object.fromEntries(Object.entries(fixture.headers).filter(([key]) => key.startsWith('anthropic-') && key !== 'anthropic-workspace-id'))
        : undefined, oauth: fixture.oauth },
    });
    expect(boundary.requests).toEqual([{
      operation: 'provider.models',
      ref: { integrationId: fixture.provider, accountId: fixture.account },
      url: fixture.url,
      method: 'GET',
      headers: fixture.headers,
      injections: fixture.injections,
      responseType: 'json',
    }]);
  });
});
