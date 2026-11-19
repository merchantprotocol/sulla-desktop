// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { BrokerCredentialFields } from '../../../../../../services/sulla-vault/src/localAuthority/BrokerCredentialFields';
import { OperationPolicy } from '../../../../../../services/sulla-vault/src/operationPolicy';
import { assertBrokeredModelCatalogUrl } from '../../../app/Services/BrokeredModelCatalogAdapters';
import { CODEX_MODELS_URL, CodexCatalogStrategy } from '../../../app/Services/BrokeredModelCatalogStrategies';

const injections = new CodexCatalogStrategy().lane().injections;
const versionedUrl = `${ CODEX_MODELS_URL }?client_version=0.170.0`;
const itemPolicy = { mode: 'agents', level: 'full', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false } as never;

const request = (overrides: Record<string, unknown> = {}) => ({
  claims:       { sub: 'user', agent_id: 'sulla', pod_id: 'model-list' },
  operation:    'provider.models',
  ref:          { integrationId: 'codex', accountId: 'subscription' },
  url:          versionedUrl,
  method:       'GET',
  injections,
  responseType: 'json',
  ...overrides,
});

describe('Codex model catalog policy', () => {
  it('pins the subscription route and exact two-header credential lane', () => {
    const strategy = new CodexCatalogStrategy();
    expect(strategy.lane()).toEqual({ url: CODEX_MODELS_URL, injections, headers: { originator: 'codex_cli_rs' }, oauth: true });
    expect(new OperationPolicy().validate(request() as never, 'chatgpt.com', itemPolicy)).toBeDefined();

    expect(() => new OperationPolicy().validate(request({ injections: [injections[0]] }) as never, 'chatgpt.com', itemPolicy)).toThrow('injection_denied');
    expect(() => new OperationPolicy().validate(request({ url: 'https://evil.example/backend-api/codex/models' }) as never, 'evil.example', itemPolicy)).toThrow('destination_denied');
    expect(() => new OperationPolicy().validate(request({ injections: [{ field: 'access_token', target: 'query', name: 'authorization', scheme: 'Bearer' }] }) as never, 'chatgpt.com', itemPolicy)).toThrow('injection_denied');
    expect(() => new OperationPolicy().validate(request({ url: CODEX_MODELS_URL }) as never, 'chatgpt.com', itemPolicy)).toThrow('query_denied');
    expect(() => new OperationPolicy().validate(request({ url: `${ CODEX_MODELS_URL }?client_version=attacker` }) as never, 'chatgpt.com', itemPolicy)).toThrow('query_denied');
  });

  it('rejects caller-controlled Codex catalog URLs before vault work', () => {
    expect(() => assertBrokeredModelCatalogUrl({ providerId: 'codex', url: versionedUrl })).not.toThrow();
    expect(() => assertBrokeredModelCatalogUrl({ providerId: 'codex', url: `${ CODEX_MODELS_URL }?client_version=attacker` })).toThrow('route is not allowed');
    expect(() => assertBrokeredModelCatalogUrl({ providerId: 'codex', url: 'https://evil.example/backend-api/codex/models' })).toThrow('route is not allowed');
    expect(() => assertBrokeredModelCatalogUrl({ providerId: 'codex', url: CODEX_MODELS_URL })).toThrow('route is not allowed');
  });

  it('derives only the bounded ChatGPT account routing header for provider.models', () => {
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-subscription-1' } })).toString('base64url');
    const properties: Record<string, string> = { access_token: `header.${ payload }.signature` };
    BrokerCredentialFields.deriveChatgptAccountRoutingForRequest({ operation: 'provider.models', ref: { integrationId: 'codex' } } as never, { integration: { properties } } as never);
    expect(properties).toEqual({ access_token: `header.${ payload }.signature`, chatgpt_account_id: 'acct-subscription-1' });
    expect(BrokerCredentialFields.safeIntegrationMetadata({ access_token: 'secret-token', chatgpt_account_id: 'acct-subscription-1' }, 'codex')).toEqual({});
  });
});
