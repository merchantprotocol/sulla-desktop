// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentPolicy } from '@sulla/vault-crypto';

import type { BrokerExecuteRequest, BrokerInjection } from './contracts.js';
import { CALLER_OPERATION_POLICIES } from './callerPolicies.js';
import { ENTERPRISE_GATEWAY_INJECTION } from './gatewayPolicy.js';

export interface BrokerOperationPolicy {
  integrations?:   string[];
  hosts?:          string[];
  requireItemSites?: boolean;
  methods:         string[];
  injections:      BrokerInjection[];
  allowStreaming?: boolean;
  binaryRequest?:  boolean;
  binaryResponse?: boolean;
  credentialOptional?: boolean;
  pathPattern?:    RegExp;
  /** Provider-specific authority that must remain coupled as one trust decision. */
  bindings?:       readonly {
    integration: string;
    hosts?:      string[];
    injections:  BrokerInjection[];
    requiredInjections?: BrokerInjection[];
    /** Optional exact one-of sets for integrations with mutually exclusive credential modes. */
    injectionSets?: readonly (readonly BrokerInjection[])[];
    pathPattern?: RegExp;
  }[];
}

const DEFAULT_TRANSFER_BYTES = 1_048_576;
const TRANSCRIPTION_REQUEST_BYTES = 17 * 1024 * 1024;
const FILES_SYNC_TRANSFER_BYTES = 6 * 1024 * 1024;
// Fits a full-screen Retina capture; base64 in the 36 MB desktop JSON body limit.
const SHARE_CONTENT_REQUEST_BYTES = 25 * 1024 * 1024;

/** The only operation that may use responseType 'base64' and the 6 MiB Files sync limits. */
export const FILES_SYNC_OPERATION = 'sulla-cloud.files-sync';

/** Request and response byte caps for the generic (non-streaming) broker execute path. */
export function brokerTransferLimits(operation: string): { request: number; response: number } {
  if (operation === FILES_SYNC_OPERATION || operation === 'sulla-cloud.cloud-files.content') return { request: FILES_SYNC_TRANSFER_BYTES, response: FILES_SYNC_TRANSFER_BYTES };
  if (operation === 'provider.transcription') return { request: TRANSCRIPTION_REQUEST_BYTES, response: DEFAULT_TRANSFER_BYTES };
  if (operation === 'sulla-cloud.shares.content') return { request: SHARE_CONTENT_REQUEST_BYTES, response: DEFAULT_TRANSFER_BYTES };
  return { request: DEFAULT_TRANSFER_BYTES, response: DEFAULT_TRANSFER_BYTES };
}

const authHeaders = (fields: string[], names = ['authorization']): BrokerInjection[] => fields.flatMap(field =>
  names.flatMap(name => ['Bearer', 'raw'].map(scheme => ({ field, target: 'header' as const, name, scheme: scheme as 'Bearer' | 'raw' }))));


const OPENAI_COMPATIBLE_PROVIDER_BINDINGS = [
  { integration: 'openrouter', hosts: ['openrouter.ai'], inference: /^\/api\/v1\/chat\/completions$/, discovery: /^\/api\/v1\/models$/ },
  { integration: 'fireworks', hosts: ['api.fireworks.ai'], inference: /^\/inference\/v1\/chat\/completions$/, discovery: /^\/inference\/v1\/models$/ },
  { integration: 'perplexity', hosts: ['api.perplexity.ai'], inference: /^\/chat\/completions$/, discovery: /^\/models$/ },
  { integration: 'zai', hosts: ['api.z.ai', 'open.bigmodel.cn'], inference: /^\/api\/(?:coding\/)?paas\/v4\/chat\/completions$/, discovery: /^\/api\/(?:coding\/)?paas\/v4\/models$/ },
  { integration: 'minimax', hosts: ['api.minimax.io', 'api.minimaxi.com'], inference: /^\/v1\/chat\/completions$/, discovery: /^\/v1\/models$/ },
  { integration: 'huggingface', hosts: ['router.huggingface.co'], inference: /^\/v1\/chat\/completions$/, discovery: /^\/v1\/models$/ },
  { integration: 'github-models', hosts: ['models.github.ai'], inference: /^\/inference\/chat\/completions$/, discovery: /^\/catalog\/models$/ },
  { integration: 'deepinfra', hosts: ['api.deepinfra.com'], inference: /^\/v1\/openai\/chat\/completions$/, discovery: /^\/v1\/openai\/models$/ },
  { integration: 'sambanova', hosts: ['api.sambanova.ai'], inference: /^\/v1\/chat\/completions$/, discovery: /^\/v1\/models$/ },
  { integration: 'ollama-cloud', hosts: ['ollama.com'], inference: /^\/v1\/chat\/completions$/, discovery: /^\/api\/tags$/ },
] as const;

const openAICompatibleInferenceBindings = OPENAI_COMPATIBLE_PROVIDER_BINDINGS.map(provider => ({
  integration: provider.integration, hosts: [...provider.hosts], injections: authHeaders(['api_key']), pathPattern: provider.inference,
}));
const openAICompatibleDiscoveryBindings = OPENAI_COMPATIBLE_PROVIDER_BINDINGS.map(provider => ({
  integration: provider.integration, hosts: [...provider.hosts], injections: authHeaders(['api_key']), pathPattern: provider.discovery,
}));

export const BROKER_OPERATION_POLICIES: Readonly<Record<string, BrokerOperationPolicy>> = {
  ...CALLER_OPERATION_POLICIES,
  'github.api': {
    integrations: ['github'],
    hosts: ['api.github.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    injections: authHeaders(['token'], ['authorization']),
  },
  'github.graphql': {
    integrations: ['github'],
    hosts: ['api.github.com'],
    methods: ['POST'],
    injections: authHeaders(['token'], ['authorization']),
  },
  'github.git': {
    integrations: ['github'],
    hosts: ['github.com'],
    methods: ['GET', 'POST'],
    injections: [{ field: 'token', target: 'header', name: 'authorization', scheme: 'GitHubBasic' }],
    allowStreaming: true,
    binaryRequest: true,
    binaryResponse: true,
    pathPattern: /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/,
  },
  'slack.web-api': {
    integrations: ['slack'],
    hosts: ['slack.com'],
    methods: ['GET', 'POST'],
    injections: authHeaders(['bot_token', 'scopes_token', 'app_token', 'app_level_token']),
  },
  'discord.rest': {
    integrations: ['discord'],
    hosts: ['discord.com', 'discordapp.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    injections: [
      { field: 'bot_token', target: 'header', name: 'authorization', scheme: 'Bot' },
      { field: 'token', target: 'header', name: 'authorization', scheme: 'Bot' },
    ],
  },
  'enterprise.gateway.http': {
    integrations: ['enterprise_gateway'],
    requireItemSites: true,
    methods: ['POST', 'DELETE'],
    injections: [ENTERPRISE_GATEWAY_INJECTION],
    pathPattern: /^\/api\/desktop\/sessions(?:\/[A-Za-z0-9._~-]{1,200})?$/,
  },
  'mcp.http': {
    integrations: ['mcp'],
    requireItemSites: true,
    methods: ['GET', 'POST'],
    allowStreaming: true,
    injections: [
      ...authHeaders(['auth_token', 'bearer_token']),
      { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' },
    ],
  },
  'catalog.http': {
    requireItemSites: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    injections: [
      ...authHeaders(['auth_token', 'bearer_token', 'api_token']),
      { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' },
      { field: 'api_key', target: 'header', name: 'api-key', scheme: 'raw' },
    ],
  },
  'item.http': {
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    injections: [],
  },
  'provider.inference': {
    integrations: ['openai', 'anthropic', 'google', 'grok', 'kimi', 'nvidia', 'alibaba', 'groq', 'mistral', 'cerebras', 'together', 'cohere', 'deepseek', 'arcee', 'custom', ...OPENAI_COMPATIBLE_PROVIDER_BINDINGS.map(provider => provider.integration)],
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
      { integration: 'kimi', hosts: ['api.moonshot.cn'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
      { integration: 'nvidia', hosts: ['integrate.api.nvidia.com'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
      { integration: 'alibaba', hosts: ['coding-intl.dashscope.aliyuncs.com'], injections: authHeaders(['api_key']), pathPattern: /^\/v1\/models$/ },
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
    integrations: ['claude-code', 'anthropic', 'openai', 'grok'],
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
  'oauth.exchange': {
    requireItemSites: true,
    methods: ['POST'],
    credentialOptional: true,
    injections: [
      { field: 'client_id', target: 'form', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'form', name: 'client_secret', scheme: 'raw' },
      { field: 'client_secret', target: 'header', name: 'authorization', scheme: 'BasicClient' },
    ],
  },
  'oauth.register': {
    integrations: ['robinhood'],
    hosts: ['agent.robinhood.com'],
    methods: ['POST'],
    credentialOptional: true,
    injections: [],
    pathPattern: /^\/oauth\/trading\/register$/,
  },
  'oauth.adopt': {
    requireItemSites: true,
    methods: ['POST'],
    injections: [
      { field: 'id_token', target: 'form', name: 'subject_token', scheme: 'raw' },
      { field: 'access_token', target: 'form', name: 'subject_token', scheme: 'raw' },
      { field: 'client_id', target: 'form', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'header', name: 'authorization', scheme: 'BasicClient' },
    ],
  },
  'oauth.refresh': {
    requireItemSites: true,
    methods: ['POST'],
    injections: [
      { field: 'refresh_token', target: 'json', name: 'refresh_token', scheme: 'raw' },
      { field: 'refresh_token', target: 'query', name: 'refresh_token', scheme: 'raw' },
      { field: 'refresh_token', target: 'form', name: 'refresh_token', scheme: 'raw' },
      { field: 'client_id', target: 'json', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'json', name: 'client_secret', scheme: 'raw' },
      { field: 'client_id', target: 'query', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'query', name: 'client_secret', scheme: 'raw' },
      { field: 'client_id', target: 'form', name: 'client_id', scheme: 'raw' },
      { field: 'client_secret', target: 'form', name: 'client_secret', scheme: 'raw' },
      { field: 'client_secret', target: 'header', name: 'authorization', scheme: 'BasicClient' },
    ],
  },
  'oauth.revoke': {
    requireItemSites: true,
    methods: ['POST'],
    injections: [
      { field: 'access_token', target: 'form', name: 'token', scheme: 'raw' },
      { field: 'refresh_token', target: 'form', name: 'token', scheme: 'raw' },
      { field: 'access_token', target: 'query', name: 'token', scheme: 'raw' },
      { field: 'refresh_token', target: 'query', name: 'token', scheme: 'raw' },
      { field: 'client_secret', target: 'header', name: 'authorization', scheme: 'BasicClient' },
    ],
  },
};

function exactInjection(left: BrokerInjection, right: BrokerInjection): boolean {
  return left.field === right.field && left.target === right.target &&
    left.name.toLowerCase() === right.name.toLowerCase() && (left.scheme ?? 'raw') === (right.scheme ?? 'raw');
}

function hostMatches(host: string, allowed: string): boolean {
  const normalized = allowed.toLowerCase().replace(/^\*\./, '');
  return host === normalized || (allowed.startsWith('*.') && host.endsWith(`.${ normalized }`));
}

/** Files' own Cloud calls (shares, encrypted backup, catalog) on the owner's Sulla Cloud login. */
export function isTrustedFilesCloudCall(input: BrokerExecuteRequest): boolean {
  return (input.operation === 'sulla-cloud.shares' || input.operation === 'sulla-cloud.shares.content' || input.operation === FILES_SYNC_OPERATION || input.operation.startsWith('sulla-cloud.cloud-files.')) &&
    input.ref.integrationId === 'sulla-cloud' && input.claims.agent_id === 'sulla-files' && input.claims.pod_id === 'sulla-files';
}

export function validateOperation(
  input: BrokerExecuteRequest,
  hostname: string,
  itemPolicy: AgentPolicy,
): BrokerOperationPolicy {
  const policy = BROKER_OPERATION_POLICIES[input.operation];
  if (!policy) throw new Error('unknown_operation');
  if (!input.ref.integrationId || (policy.integrations && !policy.integrations.includes(input.ref.integrationId))) {
    throw new Error('integration_denied');
  }
  if (!policy.methods.includes(input.method.toUpperCase())) throw new Error('method_denied');
  if (input.operation === 'enterprise.gateway.http') {
    const pathname = new URL(input.url).pathname;
    if ((input.method.toUpperCase() === 'POST' && pathname !== '/api/desktop/sessions') ||
        (input.method.toUpperCase() === 'DELETE' && !/^\/api\/desktop\/sessions\/[A-Za-z0-9._~-]{1,200}$/.test(pathname))) {
      throw new Error('method_denied');
    }
  }
  // An integration may own several bindings (one per credential lane); the
  // destination host selects the lane, so each lane's injections stay bound
  // to its own hosts.
  const candidates = policy.bindings?.filter(candidate => candidate.integration === input.ref.integrationId) ?? [];
  if (policy.bindings && !candidates.length) throw new Error('integration_denied');
  const binding = candidates.find(candidate => candidate.hosts?.some(allowed => hostMatches(hostname.toLowerCase(), allowed))) ??
    candidates[0];
  const allowedHosts = binding?.hosts ?? (policy.requireItemSites ? itemPolicy.sites : policy.hosts);
  if (!allowedHosts?.length || !allowedHosts.some(allowed => hostMatches(hostname.toLowerCase(), allowed))) {
    throw new Error('destination_denied');
  }
  // A binding is the product allowlist. Item sites are optional for bound
  // providers; when present they can only narrow that allowlist, never widen it.
  if (binding?.hosts && itemPolicy.sites?.length &&
      !itemPolicy.sites.some(allowed => hostMatches(hostname.toLowerCase(), allowed))) {
    throw new Error('destination_denied');
  }
  const streaming = input.responseType === 'stream' || input.responseType === 'binary-stream';
  if (streaming && !policy.allowStreaming) throw new Error('streaming_denied');
  if (input.responseType === 'binary-stream' && !policy.binaryResponse) throw new Error('binary_denied');
  if (input.responseType === 'base64' && input.operation !== FILES_SYNC_OPERATION && !policy.binaryResponse) throw new Error('binary_denied');
  if (input.bodyEncoding !== undefined && (!policy.binaryRequest || input.bodyEncoding !== 'base64' || typeof input.body !== 'string')) {
    throw new Error('binary_denied');
  }
  const pathPattern = binding?.pathPattern ?? policy.pathPattern;
  if (pathPattern && !pathPattern.test(new URL(input.url).pathname)) throw new Error('path_denied');
  const allowedInjections = binding?.injections ?? policy.injections;
  for (const injection of input.injections) {
    if (!allowedInjections.some(candidate => exactInjection(candidate, injection))) throw new Error('injection_denied');
  }
  if (binding?.requiredInjections?.some(required => !input.injections.some(candidate => exactInjection(candidate, required)))) {
    throw new Error('injection_denied');
  }
  if (binding?.injectionSets && !binding.injectionSets.some(set => set.length === input.injections.length &&
    set.every(required => input.injections.some(candidate => exactInjection(candidate, required))))) {
    throw new Error('injection_denied');
  }
  if (!input.injections.length && !policy.credentialOptional) throw new Error('credential_injection_required');
  return policy;
}

/** item.http is owner-declared and deliberately bypasses the integration injection allowlist. */
export function validateItemHttpOperation(input: BrokerExecuteRequest): void {
  const policy = BROKER_OPERATION_POLICIES['item.http'];
  if (!policy.methods.includes(input.method.toUpperCase())) throw new Error('method_denied');
  if (input.responseType === 'stream' || input.responseType === 'binary-stream' || input.responseType === 'base64' || input.bodyEncoding !== undefined) {
    throw new Error('streaming_denied');
  }
  if (input.injections.length) throw new Error('injection_denied');
}

export const TRUSTED_INTEGRATION_ORIGINS: Readonly<Record<string, string[]>> = {
  github:    ['api.github.com', 'github.com'],
  slack:     ['slack.com'],
  discord:   ['discord.com', 'discordapp.com'],
  openai:    ['api.openai.com'],
  codex:     ['chatgpt.com'],
  anthropic: ['api.anthropic.com'],
  'claude-code': ['api.anthropic.com'],
  google:    ['generativelanguage.googleapis.com'],
  grok:      ['api.x.ai', 'cli-chat-proxy.grok.com'],
  elevenlabs: ['api.elevenlabs.io'],
  kimi:      ['api.moonshot.ai', 'api.moonshot.cn'],
  nvidia:    ['integrate.api.nvidia.com'],
  alibaba:   ['dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'dashscope.aliyuncs.com', 'coding-intl.dashscope.aliyuncs.com', 'coding.dashscope.aliyuncs.com'],
  groq:      ['api.groq.com'],
  mistral:   ['api.mistral.ai'],
  cerebras:  ['api.cerebras.ai'],
  together:  ['api.together.xyz'],
  cohere:    ['api.cohere.ai', 'api.cohere.com'],
  deepseek:  ['api.deepseek.com'],
  arcee:     ['api.arcee.ai'],
  ...Object.fromEntries(OPENAI_COMPATIBLE_PROVIDER_BINDINGS.map(provider => [provider.integration, [...provider.hosts]])),
  enterprise_gateway: [],
};

export function trustedOriginsForIntegration(integrationId: string): string[] {
  return [...(TRUSTED_INTEGRATION_ORIGINS[integrationId] ?? [])];
}

