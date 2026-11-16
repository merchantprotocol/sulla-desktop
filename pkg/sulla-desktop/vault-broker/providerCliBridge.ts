// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import http from 'node:http';

import { ProviderModelPin } from './ProviderModelPin';
import type { BrokerInjection, ToolExecutionContext } from './index';

// This module is also loaded by the minimal sulla-tools image, which deliberately
// does not ship Desktop's Electron-backed logging stack. Keep bridge diagnostics on
// the process console so both runtimes can load the same module.
const console = globalThis.console;

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const SAFE_REQUEST_HEADERS = Object.freeze([
  'accept',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'openai-beta',
  'x-client-request-id',
]);
const BLOCKED_RESPONSE_HEADERS = Object.freeze([
  'authorization',
  'connection',
  // Node fetch transparently decompresses the broker response body but keeps
  // the upstream content-encoding header. Forwarding it makes provider CLIs
  // try to decompress plain SSE bytes and terminate the stream.
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type ProviderCliName = 'claude-code' | 'codex';
export type ProviderCliIntegration = 'anthropic' | 'claude-code' | 'codex' | 'openai';
export type ProviderCliAuthMode = 'api-key' | 'oauth';

interface ProviderDefinition {
  cli:         ProviderCliName;
  integration: ProviderCliIntegration;
  origin:      string;
  routes:      Readonly<Record<string, string>>;
  injections:  readonly BrokerInjection[];
  authMode?:   ProviderCliAuthMode;
}

const PROVIDERS: readonly ProviderDefinition[] = [
  {
    cli:         'codex',
    integration: 'openai',
    origin:      'https://api.openai.com',
    routes:      Object.freeze({ '/v1/responses': '/v1/responses', '/v1/responses/compact': '/v1/responses/compact' }),
    injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
  },
  {
    cli:         'codex',
    integration: 'codex',
    origin:      'https://chatgpt.com',
    routes:      Object.freeze({ '/v1/responses': '/backend-api/codex/responses', '/v1/responses/compact': '/backend-api/codex/responses/compact' }),
    injections: [
      { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
      { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
    ],
  },
  {
    cli:         'claude-code',
    integration: 'anthropic',
    origin:      'https://api.anthropic.com',
    routes:      Object.freeze({ '/v1/messages': '/v1/messages', '/v1/messages/count_tokens': '/v1/messages/count_tokens' }),
    injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
    authMode:   'api-key',
  },
  {
    cli:         'claude-code',
    integration: 'claude-code',
    origin:      'https://api.anthropic.com',
    routes:      Object.freeze({ '/v1/messages': '/v1/messages', '/v1/messages/count_tokens': '/v1/messages/count_tokens' }),
    injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
    authMode:   'api-key',
  },
  {
    cli:         'claude-code',
    integration: 'claude-code',
    origin:      'https://api.anthropic.com',
    routes:      Object.freeze({ '/v1/messages': '/v1/messages', '/v1/messages/count_tokens': '/v1/messages/count_tokens' }),
    injections: [{ field: 'oauth_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    authMode:   'oauth',
  },
] as const;

export interface ProviderCliBridgeIdentity {
  context:   ToolExecutionContext;
  provider:  ProviderCliName;
  accountId: string;
  /** Required for Claude Code because API-key and subscription OAuth accounts share one integration. */
  authMode?: ProviderCliAuthMode;
  /** Optional exact model allowlist supplied by the lifecycle capability. */
  models?:   readonly string[];
}

export interface ProviderCliBridgeOptions extends ProviderCliBridgeIdentity {
  /** Non-secret Anthropic account metadata, used only for API-key requests. */
  workspaceId?: string;
  /**
   * Called before binding and before every request. It must consult live
   * lifecycle state. Returning a context renews short-lived caller claims.
   */
  authorize(identity: Readonly<ProviderCliBridgeIdentity>):
    boolean | ToolExecutionContext | Promise<boolean | ToolExecutionContext>;
  /**
   * Optional credential upkeep run once per request before the upstream call
   * (e.g. refreshing an expiring OAuth session inside the vault). It must not
   * return or expose credential material; failures should be handled inside.
   */
  beforeUpstream?(identity: Readonly<ProviderCliBridgeIdentity>): Promise<void>;
  /** Emit one credential-free timing record into Desktop's perf log. */
  logTiming?(message: string): void;
  /** Abort owned by the job/process lifecycle. Aborting it revokes the lease and active stream. */
  signal?:           AbortSignal;
  broker?:           Pick<LocalVaultBrokerClient, 'executeStream' | 'requestFor'>;
  listenHost?:       string;
  /** Optional service hostname visible from the provider container. */
  advertisedHost?:   string;
  /** Map the ephemeral listen port to a caller-reachable HTTP origin. */
  advertisedOrigin?: (port: number) => string;
}

export interface ProviderCliOpaqueConfig {
  opaqueConfigRef:       string;
  baseUrl:               string;
  environment:           Readonly<Record<string, string>>;
  codexConfigOverrides?: readonly string[];
}

export interface ProviderCliBridgeLease {
  readonly config: ProviderCliOpaqueConfig;
  readonly signal: AbortSignal;
  revoke(): void;
  close(): Promise<void>;
}

export class ProviderCliBridgeTools {
  static assertIdentity(input: ProviderCliBridgeIdentity): ProviderDefinition {
  const ctx = input.context;
  const authMode = input.authMode ?? (input.provider === 'claude-code' ? 'api-key' : undefined);
  if (!ctx.sub || !ctx.agent_id || !ctx.pod_id || !ctx.device_id || !ctx.thread_id || !ctx.job_id) {
    throw new Error('Provider CLI bridge requires live subject, agent, device, thread, and job identity');
  }
  const definition = PROVIDERS.find(candidate => candidate.cli === input.provider &&
    candidate.integration === ctx.credential_scope?.integration_id && candidate.authMode === authMode);
  if (!definition || !input.accountId || ctx.credential_scope?.account_id !== input.accountId) {
    throw new Error('Provider CLI bridge identity is outside the exact provider account scope');
  }
  if (!Number.isFinite(ctx.exp) || ctx.exp * 1000 <= Date.now()) {
    throw new Error('Provider CLI bridge identity has expired');
  }
  return definition;
}

static sameIdentity(left: ToolExecutionContext, right: ToolExecutionContext): boolean {
  return left.sub === right.sub && left.agent_id === right.agent_id && left.pod_id === right.pod_id &&
    left.device_id === right.device_id && left.org_id === right.org_id && left.thread_id === right.thread_id &&
    left.job_id === right.job_id;
}

static modelAllowed(body: unknown, models: readonly string[] | undefined): boolean {
  return ProviderModelPin.allows(ProviderModelPin.requested(body), models);
}

static async liveContext(
  options: ProviderCliBridgeOptions,
  identity: Readonly<ProviderCliBridgeIdentity>,
): Promise<ToolExecutionContext | undefined> {
  const authorized = await options.authorize(identity);
  if (!authorized) return undefined;
  const context = authorized === true ? identity.context : authorized;
  ProviderCliBridgeTools.assertIdentity({ ...identity, context });
  if (!ProviderCliBridgeTools.sameIdentity(context, identity.context)) {
    throw new Error('Provider CLI bridge identity changed during renewal');
  }
  return context;
}

static safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

static requestCapability(request: http.IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  const apiKey = request.headers['x-api-key'];
  return Array.isArray(apiKey) ? undefined : apiKey;
}

static requestHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    const normalized = name.toLowerCase();
    if (!SAFE_REQUEST_HEADERS.includes(normalized) || typeof value !== 'string') return [];
    return [[normalized, value]];
  }));
}

static responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].filter(([name]) => !BLOCKED_RESPONSE_HEADERS.includes(name.toLowerCase())));
}

static async readJsonBody(request: http.IncomingMessage, signal: AbortSignal): Promise<{ body: unknown; bytes: number }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw new Error('Provider CLI request was aborted');
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new Error('Provider CLI request exceeds the broker bound');
    chunks.push(buffer);
  }
  if (signal.aborted) throw new Error('Provider CLI request was aborted');
  if (!chunks.length) throw new Error('Provider CLI request body is required');
  return { body: JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown, bytes: total };
}

static assertAdvertisedHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host)) {
    throw new Error('Provider CLI bridge advertised host must be a hostname without scheme, port, path, or credentials');
  }
  return host;
}

}

/**
 * The bridge's owning lifecycle (job, container or CLI process) already ended.
 * Sulla-side and permanent for that lifecycle: retrying the call or failing
 * over to another model cannot help, so it carries the SULLA_INFRA code the
 * model router treats as "stop here".
 */
export class ProviderBridgeRevokedError extends Error {
  readonly code = 'SULLA_INFRA';
  readonly providerBridgeRevoked = true;

  constructor() {
    super('Provider CLI bridge lifecycle is already revoked');
    this.name = 'ProviderBridgeRevokedError';
  }
}

export class ProviderCliBridgeResponsePolicy {
  static sendError(
  response: http.ServerResponse,
  status: number,
  code: string,
  extra: { message?: string; reason?: string; headers?: Record<string, string> } = {},
): void {
  console.warn(`[ProviderCliBridge] denied ${ status } ${ code }${ extra.reason ? ` reason=${ extra.reason }` : '' }`);
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json', ...extra.headers });
  response.end(JSON.stringify({
    // The CLI prints only `message`; carry the denial code so app logs say which gate refused.
    error: { type: code, message: extra.message ?? `Provider bridge request denied (${ code })`, ...(extra.reason ? { reason: extra.reason } : {}) },
  }));
  }
}

/** Seconds a provider CLI should wait before retrying a transient Sulla-side bridge failure. */
export const PROVIDER_BRIDGE_RETRY_AFTER_SECONDS = 5;

const TRANSIENT_BROKER_CODES = Object.freeze(['upstream_failed', 'upstream_timeout', 'vault_unavailable', 'database_unavailable']);
const TRANSIENT_NETWORK_CODES = Object.freeze([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
]);

export interface ProviderBridgeFailure {
  /** HTTP status returned to the provider CLI. */
  status:     number;
  /** Bridge error type returned to the CLI and written to the perf log. */
  type:       'provider_bridge_unavailable' | 'provider_bridge_failed';
  /** Error name and code (no message text, which could echo caller data). */
  errorName:  string;
  errorCode?: string;
  /** Non-secret reason code, e.g. `connect_ECONNREFUSED` from the vault or `vault_unreachable_ECONNREFUSED`. */
  reason?:    string;
  transient:  boolean;
}

export class ProviderCliBridgeFailurePolicy {
  static safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * Classify a failure that happened before upstream headers arrived. Vault
 * egress outages (network change, DNS, VPN) and a briefly unreachable vault
 * are Sulla-side and transient: the CLI gets 503 + Retry-After so it backs
 * off instead of hammering a terminal-looking 502.
 */
  static classifyProviderBridgeFailure(error: unknown): ProviderBridgeFailure {
  const value = error as { name?: unknown; code?: unknown; status?: unknown; reason?: unknown; retryable?: unknown; message?: unknown; cause?: unknown } | undefined;
  const errorName = ProviderCliBridgeFailurePolicy.safeToken(value?.name) ?? (error instanceof Error ? 'Error' : typeof error);
  const errorCode = ProviderCliBridgeFailurePolicy.safeToken(value?.code);
  const failure = (transient: boolean, reason?: string): ProviderBridgeFailure => ({
    status: transient ? 503 : 502,
    type:   transient ? 'provider_bridge_unavailable' : 'provider_bridge_failed',
    errorName,
    errorCode,
    reason,
    transient,
  });

  if (value?.name === 'VaultBrokerError') {
    const status = typeof value.status === 'number' ? value.status : 0;
    const transient = value.retryable === true || TRANSIENT_BROKER_CODES.includes(String(value.code)) || status === 503 || status === 504;
    return failure(transient, ProviderCliBridgeFailurePolicy.safeToken(value.reason) ?? errorCode);
  }
  // Desktop could not reach the vault container at all (Node fetch or Electron net).
  const cause = value?.cause as { code?: unknown } | undefined;
  const networkCode = ProviderCliBridgeFailurePolicy.safeToken(cause?.code) ?? errorCode;
  if (networkCode && TRANSIENT_NETWORK_CODES.includes(networkCode)) return failure(true, `vault_unreachable_${ networkCode }`);
  const message = typeof value?.message === 'string' ? value.message : '';
  const chromium = /\bnet::(ERR_[A-Z_]+)\b/.exec(message)?.[1];
  if (chromium) return failure(true, `vault_unreachable_${ chromium }`);
  if (/still starting its password vault/i.test(message)) return failure(true, 'vault_starting');
  return failure(false);
}
}


export { ProviderCliBridgeService } from './ProviderCliBridgeService';
