// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BrokerInjection } from '../contracts.js';
import { AuthHeaderInjections, OPENAI_COMPATIBLE_PROVIDER_BINDINGS, type BrokerOperationPolicy } from './BrokerOperationPolicy.js';

const authHeaders = (fields: string[], names?: string[]): BrokerInjection[] => AuthHeaderInjections.of(fields, names);

const openAICompatibleInferenceBindings = OPENAI_COMPATIBLE_PROVIDER_BINDINGS.map(provider => ({
  integration: provider.integration, ...('hosts' in provider ? { hosts: [...provider.hosts] } : {}), injections: provider.integration === 'azure-openai' ? [{ field: 'api_key', target: 'header' as const, name: 'api-key', scheme: 'raw' as const }] : authHeaders(['api_key']), pathPattern: provider.inference,
}));
const openAICompatibleDiscoveryBindings = OPENAI_COMPATIBLE_PROVIDER_BINDINGS.map(provider => ({
  integration: provider.integration, ...('hosts' in provider ? { hosts: [...provider.hosts] } : {}), injections: provider.integration === 'azure-openai' ? [{ field: 'api_key', target: 'header' as const, name: 'api-key', scheme: 'raw' as const }] : authHeaders(['api_key']), pathPattern: provider.discovery,
}));

/** Model provider lanes: inference, CLI, discovery, model pickers and audio. */
export const PROVIDER_OPERATION_POLICIES: Readonly<Record<string, BrokerOperationPolicy>> = {
  'provider.inference': {
    integrations: ['openai', 'anthropic', 'google', 'grok', 'kimi', 'nvidia', 'alibaba', 'groq', 'mistral', 'cerebras', 'together', 'cohere', 'deepseek', 'arcee', 'custom', 'vertex-ai', ...OPENAI_COMPATIBLE_PROVIDER_BINDINGS.map(provider => provider.integration)],
    requireItemSites: true,
    methods: ['POST'],
    allowStreaming: true,
    injections: [
      ...authHeaders(['api_key', 'api_token', 'bearer_token', 'access_token']),
      { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' },
      { field: 'api_key', target: 'header', name: 'api-key', scheme: 'raw' },
      { field: 'api_key', target: 'header', name: 'x-goog-api-key', scheme: 'raw' },
    ],
    bindings: [
      { integration: 'openai', hosts: ['api.openai.com'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/(?:chat\/completions|responses)$/ },
      {
        integration: 'anthropic', hosts: ['api.anthropic.com'],
        injections: [
          { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' },
          { field: 'workspace_id', target: 'header', name: 'anthropic-workspace-id', scheme: 'raw' },
        ],
        pathPattern: /^\/v1\/messages$/,
      },
      {
        integration: 'google', hosts: ['generativelanguage.googleapis.com'],
        injections: [{ field: 'api_key', target: 'header', name: 'x-goog-api-key', scheme: 'raw' }],
        pathPattern: /^\/v1beta\/models\/[^/]+:generateContent$/,
      },
      { integration: 'grok', hosts: ['api.x.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/(?:chat\/completions|responses)$/ },
      {
        integration: 'grok', hosts: ['cli-chat-proxy.grok.com'],
        injections: [{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
        injectionSets: [[{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }]],
        pathPattern: /^\/v1\/responses$/,
      },
      { integration: 'kimi', hosts: ['api.moonshot.ai', 'api.moonshot.cn'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/chat\/completions$/ },
      { integration: 'nvidia', hosts: ['integrate.api.nvidia.com'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/chat\/completions$/ },
      {
        integration: 'alibaba',
        hosts: ['dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'dashscope.aliyuncs.com', 'coding-intl.dashscope.aliyuncs.com', 'coding.dashscope.aliyuncs.com'],
        injections: authHeaders(['api_key']),
        pathPattern: /^\/(?:compatible-mode\/)?v1\/chat\/completions$/,
      },
      { integration: 'groq', hosts: ['api.groq.com'], injections: authHeaders(['api_key']), pathPattern: /^\/openai\/v1\/chat\/completions$/ },
      { integration: 'mistral', hosts: ['api.mistral.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/chat\/completions$/ },
      { integration: 'cerebras', hosts: ['api.cerebras.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/chat\/completions$/ },
      { integration: 'together', hosts: ['api.together.xyz'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/chat\/completions$/ },
      { integration: 'cohere', hosts: ['api.cohere.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/compatibility\/v1\/chat\/completions$/ },
      { integration: 'deepseek', hosts: ['api.deepseek.com'], injections: authHeaders(['api_key']), pathPattern: /^\/(?:v1\/)?chat\/completions$/ },
      { integration: 'arcee', hosts: ['api.arcee.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/api\/v1\/chat\/completions$/ },
      { integration: 'vertex-ai', injections: [{ field: 'api_key', target: 'header', name: 'x-goog-api-key', scheme: 'raw' }], pathPattern: /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\/[^/]+:generateContent$/ },
      ...openAICompatibleInferenceBindings,
      // A custom endpoint has no globally trusted host. Its item policy is the
      // authority and is populated from the user-entered HTTPS base URL.
      { integration: 'custom', injections: authHeaders(['api_key']), pathPattern: /^\/(?:v1\/)?chat\/completions$/ },
    ],
  },
  'provider.cli': {
    integrations: ['openai', 'codex', 'anthropic', 'claude-code'],
    methods: ['POST'],
    allowStreaming: true,
    injections: [],
    bindings: [
      {
        integration: 'openai',
        hosts: ['api.openai.com'],
        injections: authHeaders(['api_key']),
        pathPattern: /^\/v1\/responses(?:\/compact)?$/,
      },
      {
        integration: 'codex',
        hosts: ['chatgpt.com'],
        injections: [
          { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
          { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
        ],
        requiredInjections: [
          { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
          { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
        ],
        pathPattern: /^\/backend-api\/codex\/responses(?:\/compact)?$/,
      },
      {
        integration: 'anthropic',
        hosts: ['api.anthropic.com'],
        injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
        pathPattern: /^\/v1\/messages(?:\/count_tokens)?$/,
      },
      {
        integration: 'claude-code',
        hosts: ['api.anthropic.com'],
        injections: [
          { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' },
          { field: 'oauth_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
        ],
        injectionSets: [
          [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
          [{ field: 'oauth_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
        ],
        pathPattern: /^\/v1\/messages(?:\/count_tokens)?$/,
      },
    ],
  },
  'provider.discovery': {
    integrations: ['openai', 'anthropic', 'google', 'grok', 'kimi', 'nvidia', 'alibaba', 'groq', 'mistral', 'cerebras', 'together', 'cohere', 'deepseek', 'arcee', 'custom', ...OPENAI_COMPATIBLE_PROVIDER_BINDINGS.map(provider => provider.integration)],
    requireItemSites: true,
    methods: ['GET'],
    injections: [],
    bindings: [
      { integration: 'openai', hosts: ['api.openai.com'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
      { integration: 'anthropic', hosts: ['api.anthropic.com'], injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }], pathPattern: /^\/v1\/models$/ },
      { integration: 'google', hosts: ['generativelanguage.googleapis.com'], injections: authHeaders(['api_key']), pathPattern: /^\/v1beta\/models$/ },
      { integration: 'grok', hosts: ['api.x.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
      { integration: 'kimi', hosts: ['api.moonshot.ai', 'api.moonshot.cn'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
      { integration: 'nvidia', hosts: ['integrate.api.nvidia.com'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
      { integration: 'alibaba', hosts: ['dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'dashscope.aliyuncs.com', 'coding-intl.dashscope.aliyuncs.com', 'coding.dashscope.aliyuncs.com'], injections: authHeaders(['api_key']), pathPattern: /^\/(?:v1|compatible-mode\/v1)\/models$/ },
      { integration: 'groq', hosts: ['api.groq.com'], injections: authHeaders(['api_key']), pathPattern: /^\/openai\/v1\/models$/ },
      { integration: 'mistral', hosts: ['api.mistral.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
      { integration: 'cerebras', hosts: ['api.cerebras.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
      { integration: 'together', hosts: ['api.together.xyz'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
      { integration: 'cohere', hosts: ['api.cohere.com', 'api.cohere.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/v2\/models$/ },
      { integration: 'deepseek', hosts: ['api.deepseek.com'], injections: authHeaders(['api_key']), pathPattern: /^\/models$/ },
      { integration: 'arcee', hosts: ['api.arcee.ai'], injections: authHeaders(['api_key']), pathPattern: /^\/api\/v1\/models$/ },
      ...openAICompatibleDiscoveryBindings,
      { integration: 'custom', injections: authHeaders(['api_key']), pathPattern: /^\/(?:v1|v1beta)\/models$/ },
    ],
  },
  // Desktop model pickers listing the catalog of the selected provider account.
  // GET-only, exact host + path per credential lane; the response is the
  // provider's model list, never the credential.
  'provider.models': {
    integrations: ['claude-code', 'anthropic', 'openai', 'codex', 'grok', 'kimi', 'alibaba'],
    methods: ['GET'],
    injections: [],
    bindings: [
      {
        integration: 'claude-code',
        hosts: ['api.anthropic.com'],
        injections: [
          { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' },
          { field: 'oauth_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
        ],
        injectionSets: [
          [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
          [{ field: 'oauth_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
        ],
        pathPattern: /^\/v1\/models$/,
      },
      {
        integration: 'anthropic',
        hosts: ['api.anthropic.com'],
        injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
        injectionSets: [[{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }]],
        pathPattern: /^\/v1\/models$/,
      },
      {
        integration: 'openai',
        hosts: ['api.openai.com'],
        injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
        injectionSets: [[{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }]],
        pathPattern: /^\/v1\/models$/,
      },
      {
        integration: 'codex',
        hosts: ['chatgpt.com'],
        injections: [
          { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
          { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
        ],
        requiredInjections: [
          { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
          { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
        ],
        injectionSets: [[
          { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
          { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
        ]],
        pathPattern: /^\/backend-api\/codex\/models$/,
      },
      // Grok has two billing lanes that must never cross: a pasted API key
      // only goes to the metered api.x.ai catalog, the Sign-in-with-Grok
      // OAuth token only goes to the grok-cli subscription proxy.
      {
        integration: 'grok',
        hosts: ['api.x.ai'],
        injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
        injectionSets: [[{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }]],
        pathPattern: /^\/v1\/models$/,
      },
      {
        integration: 'kimi',
        hosts: ['api.moonshot.ai', 'api.moonshot.cn'],
        injections: authHeaders(['api_key']),
        pathPattern: /^\/v1\/models$/,
      },
      {
        integration: 'alibaba',
        hosts: ['dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'dashscope.aliyuncs.com', 'coding-intl.dashscope.aliyuncs.com', 'coding.dashscope.aliyuncs.com'],
        injections: authHeaders(['api_key']),
        pathPattern: /^\/(?:v1|compatible-mode\/v1)\/models$/,
      },
      {
        integration: 'grok',
        hosts: ['cli-chat-proxy.grok.com'],
        injections: [{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
        injectionSets: [[{ field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' }]],
        pathPattern: /^\/v1\/models$/,
      },
    ],
  },
  'provider.audio': {
    integrations: ['elevenlabs', 'grok'],
    methods: ['POST'],
    allowStreaming: true,
    binaryResponse: true,
    injections: [],
    bindings: [
      {
        integration: 'elevenlabs',
        hosts: ['api.elevenlabs.io'],
        injections: [{ field: 'api_key', target: 'header', name: 'xi-api-key', scheme: 'raw' }],
        pathPattern: /^\/v1\/text-to-speech\/[A-Za-z0-9_-]+\/stream$/,
      },
      {
        integration: 'grok',
        hosts: ['api.x.ai'],
        injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
        pathPattern: /^\/v1\/tts$/,
      },
    ],
  },
};
