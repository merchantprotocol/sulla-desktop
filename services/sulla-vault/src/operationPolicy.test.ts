// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateOperation } from './operationPolicy.js';

import type { AgentPolicy } from '@sulla/vault-crypto';
import type { BrokerExecuteRequest, BrokerInjection } from './contracts.js';

const ITEM_POLICY = { level: 'autofill', agents: [], sites: [] } as unknown as AgentPolicy;
const X_API_KEY: BrokerInjection = { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' };
const OAUTH_BEARER: BrokerInjection = { field: 'oauth_token', target: 'header', name: 'authorization', scheme: 'Bearer' };
const API_KEY_BEARER: BrokerInjection = { field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' };
const ACCESS_BEARER: BrokerInjection = { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' };

function request(integrationId: string, url: string, injections: BrokerInjection[], method = 'GET'): BrokerExecuteRequest {
  return {
    claims:     { sub: 'user', agent_id: 'sulla', pod_id: 'sulla-model-list-test' },
    operation:  'provider.models',
    ref:        { integrationId, accountId: 'default' },
    url,
    method,
    injections,
  } as unknown as BrokerExecuteRequest;
}

function check(req: BrokerExecuteRequest) {
  return validateOperation(req, new URL(req.url).hostname, ITEM_POLICY);
}

test('provider.models allows each provider lane on its exact catalog endpoint', () => {
  assert.doesNotThrow(() => check(request('claude-code', 'https://api.anthropic.com/v1/models', [X_API_KEY])));
  assert.doesNotThrow(() => check(request('claude-code', 'https://api.anthropic.com/v1/models', [OAUTH_BEARER])));
  assert.doesNotThrow(() => check(request('claude-code', 'https://api.anthropic.com/v1/models?limit=1000', [X_API_KEY])));
  assert.doesNotThrow(() => check(request('anthropic', 'https://api.anthropic.com/v1/models', [X_API_KEY])));
  assert.doesNotThrow(() => check(request('openai', 'https://api.openai.com/v1/models', [API_KEY_BEARER])));
  assert.doesNotThrow(() => check(request('grok', 'https://api.x.ai/v1/models', [API_KEY_BEARER])));
  assert.doesNotThrow(() => check(request('grok', 'https://cli-chat-proxy.grok.com/v1/models', [ACCESS_BEARER])));
});

test('provider.models denies other methods, hosts, and paths', () => {
  assert.throws(() => check(request('openai', 'https://api.openai.com/v1/models', [API_KEY_BEARER], 'POST')), /method_denied/);
  assert.throws(() => check(request('claude-code', 'https://evil.example.com/v1/models', [X_API_KEY])), /destination_denied/);
  assert.throws(() => check(request('anthropic', 'https://api.openai.com/v1/models', [X_API_KEY])), /destination_denied/);
  assert.throws(() => check(request('claude-code', 'https://api.anthropic.com/v1/messages', [X_API_KEY])), /path_denied/);
  assert.throws(() => check(request('openai', 'https://api.openai.com/v1/models/gpt-4o', [API_KEY_BEARER])), /path_denied/);
  assert.throws(() => check(request('grok', 'https://cli-chat-proxy.grok.com/v1/responses', [ACCESS_BEARER])), /path_denied/);
});

test('provider.models denies unknown integrations', () => {
  assert.throws(() => check(request('codex', 'https://chatgpt.com/backend-api/codex/models', [ACCESS_BEARER])), /integration_denied/);
  assert.throws(() => check(request('github', 'https://api.openai.com/v1/models', [API_KEY_BEARER])), /integration_denied/);
  assert.throws(() => check(request('', 'https://api.openai.com/v1/models', [API_KEY_BEARER])), /integration_denied/);
});

test('provider.models denies injections outside the registered lane', () => {
  // claude-code: exactly one of the two credential modes, never both, never none.
  assert.throws(() => check(request('claude-code', 'https://api.anthropic.com/v1/models', [X_API_KEY, OAUTH_BEARER])), /injection_denied/);
  assert.throws(() => check(request('claude-code', 'https://api.anthropic.com/v1/models', [])), /injection_denied/);
  assert.throws(() => check(request('claude-code', 'https://api.anthropic.com/v1/models', [API_KEY_BEARER])), /injection_denied/);
  assert.throws(() => check(request('anthropic', 'https://api.anthropic.com/v1/models', [OAUTH_BEARER])), /injection_denied/);
  assert.throws(() => check(request('openai', 'https://api.openai.com/v1/models', [{ ...API_KEY_BEARER, target: 'query' }])), /injection_denied/);
  // Grok lanes never cross: API key only to api.x.ai, OAuth token only to the subscription proxy.
  assert.throws(() => check(request('grok', 'https://api.x.ai/v1/models', [ACCESS_BEARER])), /injection_denied/);
  assert.throws(() => check(request('grok', 'https://cli-chat-proxy.grok.com/v1/models', [API_KEY_BEARER])), /injection_denied/);
});

test('every lane the desktop builds is accepted by provider.models', async() => {
  // The desktop helper and this policy must agree; a drift would silently
  // degrade every picker to its static list.
  const { modelListLane } = await import('../../../pkg/sulla-desktop/agent/services/brokeredModelLanes.js');
  const lanes: [string, string][] = [
    ['claude-code', 'oauth'], ['claude-code', 'default'], ['anthropic', 'default'], ['openai', 'default'], ['grok', 'oauth'], ['grok', 'default'],
  ];
  for (const [providerId, accountId] of lanes) {
    const lane = modelListLane(providerId, accountId);
    assert.ok(lane, `${ providerId }/${ accountId } has a lane`);
    assert.doesNotThrow(() => check({ ...request(providerId, lane.url, lane.injections), ref: { integrationId: providerId, accountId } } as BrokerExecuteRequest),
      `${ providerId }/${ accountId }`);
  }
  assert.equal(modelListLane('codex', 'oauth'), null);
});

test('existing single-binding operations keep their behavior', () => {
  const cli = { ...request('claude-code', 'https://api.anthropic.com/v1/messages', [OAUTH_BEARER], 'POST'), operation: 'provider.cli' } as BrokerExecuteRequest;
  assert.doesNotThrow(() => check(cli));
  assert.throws(() => check({ ...cli, url: 'https://api.anthropic.com/v1/models' } as BrokerExecuteRequest), /path_denied/);
  assert.throws(() => check({ ...cli, operation: 'provider.unknown' } as BrokerExecuteRequest), /unknown_operation/);
});

const INFERENCE_LANES: Array<[string, string, BrokerInjection[]]> = [
  ['openai', 'https://api.openai.com/v1/chat/completions', [API_KEY_BEARER]],
  ['anthropic', 'https://api.anthropic.com/v1/messages', [X_API_KEY]],
  ['google', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    [{ field: 'api_key', target: 'header', name: 'x-goog-api-key', scheme: 'raw' }]],
  ['grok', 'https://api.x.ai/v1/responses', [API_KEY_BEARER]],
  ['grok', 'https://cli-chat-proxy.grok.com/v1/responses', [ACCESS_BEARER]],
  ['kimi', 'https://api.moonshot.ai/v1/chat/completions', [API_KEY_BEARER]],
  ['kimi', 'https://api.moonshot.cn/v1/chat/completions', [API_KEY_BEARER]],
  ['nvidia', 'https://integrate.api.nvidia.com/v1/chat/completions', [API_KEY_BEARER]],
  ['alibaba', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', [API_KEY_BEARER]],
  ['alibaba', 'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions', [API_KEY_BEARER]],
  ['alibaba', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', [API_KEY_BEARER]],
  ['alibaba', 'https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions', [API_KEY_BEARER]],
  ['alibaba', 'https://coding.dashscope.aliyuncs.com/v1/chat/completions', [API_KEY_BEARER]],
  ['groq', 'https://api.groq.com/openai/v1/chat/completions', [API_KEY_BEARER]],
  ['mistral', 'https://api.mistral.ai/v1/chat/completions', [API_KEY_BEARER]],
  ['cerebras', 'https://api.cerebras.ai/v1/chat/completions', [API_KEY_BEARER]],
  ['together', 'https://api.together.xyz/v1/chat/completions', [API_KEY_BEARER]],
  ['cohere', 'https://api.cohere.ai/compatibility/v1/chat/completions', [API_KEY_BEARER]],
  ['deepseek', 'https://api.deepseek.com/chat/completions', [API_KEY_BEARER]],
  ['arcee', 'https://api.arcee.ai/api/v1/chat/completions', [API_KEY_BEARER]],
];

test('provider.inference accepts every AI integration chat lane with empty item sites', () => {
  for (const [integrationId, url, injections] of INFERENCE_LANES) {
    const req = { ...request(integrationId, url, injections, 'POST'), operation: 'provider.inference' } as BrokerExecuteRequest;
    assert.doesNotThrow(() => check(req), `${ integrationId } ${ url }`);
  }
});

test('provider.inference rejects wrong hosts and item sites can only narrow bindings', () => {
  for (const [integrationId, url, injections] of INFERENCE_LANES) {
    const req = { ...request(integrationId, url, injections, 'POST'), operation: 'provider.inference' } as BrokerExecuteRequest;
    const wrong = new URL(url);
    wrong.hostname = 'evil.example.com';
    assert.throws(() => check({ ...req, url: wrong.toString() } as BrokerExecuteRequest), /destination_denied/, integrationId);
    assert.throws(
      () => validateOperation(req, new URL(url).hostname, { ...ITEM_POLICY, sites: ['other.example.com'] }),
      /destination_denied/,
      `${ integrationId } item sites narrow`,
    );
  }
});

test('provider.inference binds custom to the HTTPS base host stored in item sites', () => {
  const req = {
    ...request('custom', 'https://models.example.com/v1/chat/completions', [API_KEY_BEARER], 'POST'),
    operation: 'provider.inference',
  } as BrokerExecuteRequest;
  const policy = { ...ITEM_POLICY, sites: ['models.example.com'] } as AgentPolicy;
  assert.doesNotThrow(() => validateOperation(req, 'models.example.com', policy));
  assert.throws(() => validateOperation({ ...req, url: 'https://evil.example.com/v1/chat/completions' }, 'evil.example.com', policy), /destination_denied/);
});
