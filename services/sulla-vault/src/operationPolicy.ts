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
  bindings?:       ReadonlyArray<{
    integration: string;
    hosts?:      string[];
    injections:  BrokerInjection[];
    requiredInjections?: BrokerInjection[];
    pathPattern?: RegExp;
  }>;
}

const authHeaders = (fields: string[], names = ['authorization']): BrokerInjection[] => fields.flatMap(field =>
  names.flatMap(name => ['Bearer', 'raw'].map(scheme => ({ field, target: 'header' as const, name, scheme: scheme as 'Bearer' | 'raw' }))));

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
  'provider.inference': {
    integrations: ['openai', 'anthropic', 'google', 'grok', 'kimi', 'nvidia', 'alibaba', 'groq', 'mistral', 'cerebras', 'together', 'cohere', 'deepseek', 'arcee', 'custom'],
    requireItemSites: true,
    methods: ['POST'],
    allowStreaming: true,
    injections: [
      ...authHeaders(['api_key', 'api_token', 'bearer_token', 'access_token']),
      { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' },
      { field: 'api_key', target: 'header', name: 'api-key', scheme: 'raw' },
      { field: 'api_key', target: 'header', name: 'x-goog-api-key', scheme: 'raw' },
    ],
  },
  'provider.cli': {
    integrations: ['openai', 'codex', 'anthropic'],
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
    ],
  },
  'provider.discovery': {
    integrations: ['openai', 'anthropic', 'google', 'grok', 'kimi', 'nvidia', 'alibaba', 'groq', 'mistral', 'cerebras', 'together', 'cohere', 'deepseek', 'arcee', 'custom'],
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
      { integration: 'custom', injections: authHeaders(['api_key']), pathPattern: /^\/(?:v1|v1beta)\/models$/ },
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
  const binding = policy.bindings?.find(candidate => candidate.integration === input.ref.integrationId);
  if (policy.bindings && !binding) throw new Error('integration_denied');
  const allowedHosts = binding?.hosts ?? (policy.requireItemSites ? itemPolicy.sites : policy.hosts);
  if (!allowedHosts?.length || !allowedHosts.some(allowed => hostMatches(hostname.toLowerCase(), allowed))) {
    throw new Error('destination_denied');
  }
  const streaming = input.responseType === 'stream' || input.responseType === 'binary-stream';
  if (streaming && !policy.allowStreaming) throw new Error('streaming_denied');
  if (input.responseType === 'binary-stream' && !policy.binaryResponse) throw new Error('binary_denied');
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
  if (!input.injections.length && !policy.credentialOptional) throw new Error('credential_injection_required');
  return policy;
}

export const TRUSTED_INTEGRATION_ORIGINS: Readonly<Record<string, string[]>> = {
  github:    ['api.github.com', 'github.com'],
  slack:     ['slack.com'],
  discord:   ['discord.com', 'discordapp.com'],
  openai:    ['api.openai.com'],
  codex:     ['chatgpt.com'],
  anthropic: ['api.anthropic.com'],
  google:    ['generativelanguage.googleapis.com'],
  grok:      ['api.x.ai'],
  elevenlabs: ['api.elevenlabs.io'],
  kimi:      ['api.moonshot.cn'],
  nvidia:    ['integrate.api.nvidia.com'],
  alibaba:   ['coding-intl.dashscope.aliyuncs.com'],
  groq:      ['api.groq.com'],
  mistral:   ['api.mistral.ai'],
  cerebras:  ['api.cerebras.ai'],
  together:  ['api.together.xyz'],
  cohere:    ['api.cohere.ai', 'api.cohere.com'],
  deepseek:  ['api.deepseek.com'],
  arcee:     ['api.arcee.ai'],
  enterprise_gateway: [],
};

export function trustedOriginsForIntegration(integrationId: string): string[] {
  return [...(TRUSTED_INTEGRATION_ORIGINS[integrationId] ?? [])];
}

