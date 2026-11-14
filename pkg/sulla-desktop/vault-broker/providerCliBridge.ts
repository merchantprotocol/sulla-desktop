// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import http from 'node:http';

import { requireConfiguredCredentialBroker } from './index';
import { recordVaultFailure, recordVaultSuccess, vaultFailureKind } from './vaultHealth';

import type { BrokerInjection, ToolExecutionContext, LocalVaultBrokerClient } from './index';

// This module is also loaded by the minimal sulla-tools image, which deliberately
// does not ship Desktop's Electron-backed logging stack. Keep bridge diagnostics on
// the process console so both runtimes can load the same module.
const console = globalThis.console;

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'openai-beta',
  'x-client-request-id',
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
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
  routes:      ReadonlyMap<string, string>;
  injections:  readonly BrokerInjection[];
  authMode?:   ProviderCliAuthMode;
}

const PROVIDERS: readonly ProviderDefinition[] = [
  {
    cli:         'codex',
    integration: 'openai',
    origin:      'https://api.openai.com',
    routes:      new Map([
      ['/v1/responses', '/v1/responses'],
      ['/v1/responses/compact', '/v1/responses/compact'],
    ]),
    injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
  },
  {
    cli:         'codex',
    integration: 'codex',
    origin:      'https://chatgpt.com',
    routes:      new Map([
      ['/v1/responses', '/backend-api/codex/responses'],
      ['/v1/responses/compact', '/backend-api/codex/responses/compact'],
    ]),
    injections: [
      { field: 'access_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
      { field: 'chatgpt_account_id', target: 'header', name: 'chatgpt-account-id', scheme: 'raw' },
    ],
  },
  {
    cli:         'claude-code',
    integration: 'anthropic',
    origin:      'https://api.anthropic.com',
    routes:      new Map([
      ['/v1/messages', '/v1/messages'],
      ['/v1/messages/count_tokens', '/v1/messages/count_tokens'],
    ]),
    injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
    authMode:   'api-key',
  },
  {
    cli:         'claude-code',
    integration: 'claude-code',
    origin:      'https://api.anthropic.com',
    routes:      new Map([
      ['/v1/messages', '/v1/messages'],
      ['/v1/messages/count_tokens', '/v1/messages/count_tokens'],
    ]),
    injections: [{ field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' }],
    authMode:   'api-key',
  },
  {
    cli:         'claude-code',
    integration: 'claude-code',
    origin:      'https://api.anthropic.com',
    routes:      new Map([
      ['/v1/messages', '/v1/messages'],
      ['/v1/messages/count_tokens', '/v1/messages/count_tokens'],
    ]),
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

function assertIdentity(input: ProviderCliBridgeIdentity): ProviderDefinition {
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

function sameIdentity(left: ToolExecutionContext, right: ToolExecutionContext): boolean {
  return left.sub === right.sub && left.agent_id === right.agent_id && left.pod_id === right.pod_id &&
    left.device_id === right.device_id && left.org_id === right.org_id && left.thread_id === right.thread_id &&
    left.job_id === right.job_id;
}

function modelAllowed(body: unknown, models: readonly string[] | undefined): boolean {
  if (!models?.length) return true;
  const model = body && typeof body === 'object' && !Array.isArray(body) && 'model' in body
    ? (body as { model?: unknown }).model
    : undefined;
  return typeof model === 'string' && models.includes(model);
}

async function liveContext(
  options: ProviderCliBridgeOptions,
  identity: Readonly<ProviderCliBridgeIdentity>,
): Promise<ToolExecutionContext | undefined> {
  const authorized = await options.authorize(identity);
  if (!authorized) return undefined;
  const context = authorized === true ? identity.context : authorized;
  assertIdentity({ ...identity, context });
  if (!sameIdentity(context, identity.context)) {
    throw new Error('Provider CLI bridge identity changed during renewal');
  }
  return context;
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function requestCapability(request: http.IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  const apiKey = request.headers['x-api-key'];
  return Array.isArray(apiKey) ? undefined : apiKey;
}

function requestHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    const normalized = name.toLowerCase();
    if (!SAFE_REQUEST_HEADERS.has(normalized) || typeof value !== 'string') return [];
    return [[normalized, value]];
  }));
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].filter(([name]) => !BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())));
}

async function readJsonBody(request: http.IncomingMessage, signal: AbortSignal): Promise<{ body: unknown; bytes: number }> {
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

function assertAdvertisedHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host)) {
    throw new Error('Provider CLI bridge advertised host must be a hostname without scheme, port, path, or credentials');
  }
  return host;
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

function sendError(
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

/** Seconds a provider CLI should wait before retrying a transient Sulla-side bridge failure. */
export const PROVIDER_BRIDGE_RETRY_AFTER_SECONDS = 5;

const TRANSIENT_BROKER_CODES = new Set(['upstream_failed', 'upstream_timeout', 'vault_unavailable', 'database_unavailable']);
const TRANSIENT_NETWORK_CODES = new Set([
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

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * Classify a failure that happened before upstream headers arrived. Vault
 * egress outages (network change, DNS, VPN) and a briefly unreachable vault
 * are Sulla-side and transient: the CLI gets 503 + Retry-After so it backs
 * off instead of hammering a terminal-looking 502.
 */
export function classifyProviderBridgeFailure(error: unknown): ProviderBridgeFailure {
  const value = error as { name?: unknown; code?: unknown; status?: unknown; reason?: unknown; retryable?: unknown; message?: unknown; cause?: unknown } | undefined;
  const errorName = safeToken(value?.name) ?? (error instanceof Error ? 'Error' : typeof error);
  const errorCode = safeToken(value?.code);
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
    const transient = value.retryable === true || TRANSIENT_BROKER_CODES.has(String(value.code)) || status === 503 || status === 504;
    return failure(transient, safeToken(value.reason) ?? errorCode);
  }
  // Desktop could not reach the vault container at all (Node fetch or Electron net).
  const cause = value?.cause as { code?: unknown } | undefined;
  const networkCode = safeToken(cause?.code) ?? errorCode;
  if (networkCode && TRANSIENT_NETWORK_CODES.has(networkCode)) return failure(true, `vault_unreachable_${ networkCode }`);
  const message = typeof value?.message === 'string' ? value.message : '';
  const chromium = /\bnet::(ERR_[A-Z_]+)\b/.exec(message)?.[1];
  if (chromium) return failure(true, `vault_unreachable_${ chromium }`);
  if (/still starting its password vault/i.test(message)) return failure(true, 'vault_starting');
  return failure(false);
}

/**
 * Create one process-scoped HTTP adapter. The returned environment contains
 * only a random bridge capability; the provider credential stays in vault
 * authority custody and is injected into the final upstream request there.
 */
export async function createProviderCliBridge(options: ProviderCliBridgeOptions): Promise<ProviderCliBridgeLease> {
  const definition = assertIdentity(options);
  if (options.signal?.aborted) throw new ProviderBridgeRevokedError();
  const advertisedHost = options.advertisedHost ? assertAdvertisedHost(options.advertisedHost) : undefined;
  const listenHost = options.listenHost ?? (advertisedHost ? '0.0.0.0' : '127.0.0.1');
  if (!advertisedHost && ['0.0.0.0', '::'].includes(listenHost)) {
    throw new Error('Provider CLI bridge requires an advertised service hostname for a non-loopback listener');
  }
  if (options.models?.some(model => !model.trim())) {
    throw new Error('Provider CLI bridge model scope contains an invalid model');
  }
  const identity: Readonly<ProviderCliBridgeIdentity> = Object.freeze({
    context:   options.context,
    provider:  options.provider,
    accountId: options.accountId,
    authMode:  options.authMode,
    models:    options.models ? Object.freeze([...options.models]) : undefined,
  });
  if (!await liveContext(options, identity)) throw new Error('Provider CLI bridge identity is not active');

  const broker = options.broker ?? requireConfiguredCredentialBroker();
  const capability = crypto.randomBytes(32).toString('base64url');
  const opaqueConfigRef = crypto.randomUUID();
  const scopedPrefix = `/${ crypto.randomBytes(24).toString('base64url') }`;
  const lifetime = new AbortController();
  const revoke = () => lifetime.abort();
  options.signal?.addEventListener('abort', revoke, { once: true });
  if (options.signal?.aborted) revoke();

  let beforeUpstreamCache: { expiresAt: number; promise: Promise<void> } | undefined;
  const runBeforeUpstream = (): Promise<void> => {
    if (!options.beforeUpstream) return Promise.resolve();
    const now = Date.now();
    if (beforeUpstreamCache && beforeUpstreamCache.expiresAt > now) return beforeUpstreamCache.promise;
    const promise = options.beforeUpstream(identity);
    beforeUpstreamCache = { expiresAt: now + 5_000, promise };
    promise.catch(() => { if (beforeUpstreamCache?.promise === promise) beforeUpstreamCache = undefined; });
    return promise;
  };

  const server = http.createServer(async(request, response) => {
    const startedAt = performance.now();
    let bodyBytes = 0;
    let requestBodyReadMs = 0;
    let liveContextMs = 0;
    let beforeUpstreamMs = 0;
    let upstreamHeadersMs = 0;
    let firstChunkMs = 0;
    let status = 500;
    let timingPath = 'unknown';
    let failureNote = '';
    response.socket?.setNoDelay(true);
    const requestAbort = new AbortController();
    const abort = () => {
      requestAbort.abort();
      request.destroy();
    };
    lifetime.signal.addEventListener('abort', abort, { once: true });
    request.once('aborted', abort);
    request.once('close', () => {
      if (!request.complete) abort();
    });
    response.once('close', () => {
      if (!response.writableEnded) abort();
    });

    try {
      if (lifetime.signal.aborted || !safeEqual(requestCapability(request), capability)) {
        status = 401;
        sendError(response, status, 'invalid_bridge_capability');
        return;
      }
      const incoming = new URL(request.url ?? '/', 'http://provider-bridge.invalid');
      if (request.method !== 'POST' || incoming.hash || !incoming.pathname.startsWith(scopedPrefix)) {
        status = 404;
        sendError(response, status, 'unsupported_provider_route');
        return;
      }
      const incomingPath = incoming.pathname.slice(scopedPrefix.length);
      const upstreamPath = definition.routes.get(incomingPath);
      timingPath = incomingPath;
      const upstreamSearch = definition.cli === 'claude-code' && incoming.search === '?beta=true'
        ? incoming.search
        : '';
      if (!upstreamPath || (incoming.search && !upstreamSearch)) {
        status = 404;
        sendError(response, status, 'unsupported_provider_route');
        return;
      }
      const initialContextStartedAt = performance.now();
      let context: ToolExecutionContext | undefined;
      try {
        context = await liveContext(options, identity);
      } catch {
        liveContextMs = performance.now() - initialContextStartedAt;
        revoke();
        status = 403;
        sendError(response, status, 'provider_bridge_identity_changed');
        return;
      }
      liveContextMs = performance.now() - initialContextStartedAt;
      if (!context) {
        revoke();
        status = 403;
        sendError(response, status, 'provider_bridge_revoked');
        return;
      }
      const bodyStartedAt = performance.now();
      const bodyResult = await readJsonBody(request, requestAbort.signal);
      requestBodyReadMs = performance.now() - bodyStartedAt;
      bodyBytes = bodyResult.bytes;

      const contextStartedAt = performance.now();
      try {
        context = await liveContext(options, identity);
      } catch {
        liveContextMs += performance.now() - contextStartedAt;
        revoke();
        status = 403;
        sendError(response, status, 'provider_bridge_identity_changed');
        return;
      }
      liveContextMs += performance.now() - contextStartedAt;
      if (!context) {
        revoke();
        status = 403;
        sendError(response, status, 'provider_bridge_revoked');
        return;
      }
      if (!modelAllowed(bodyResult.body, identity.models)) {
        status = 403;
        sendError(response, status, 'provider_model_denied');
        return;
      }
      const headers = requestHeaders(request.headers);
      const workspaceId = options.workspaceId?.trim();
      if (definition.cli === 'claude-code' && definition.authMode === 'api-key' && workspaceId) {
        headers['anthropic-workspace-id'] = workspaceId;
      }
      if (definition.integration === 'codex') {
        headers.originator = 'codex_cli_rs';
        headers['session-id'] = context.thread_id!;
        headers['thread-id'] = context.thread_id!;
      }
      const upkeepStartedAt = performance.now();
      await runBeforeUpstream();
      beforeUpstreamMs = performance.now() - upkeepStartedAt;
      const upstreamStartedAt = performance.now();
      const upstream = await broker.executeStream(broker.requestFor(context, {
        operation:    'provider.cli',
        ref:          { integrationId: definition.integration, accountId: options.accountId },
        url:          `${ definition.origin }${ upstreamPath }${ upstreamSearch }`,
        method:       'POST',
        headers,
        body:         bodyResult.body,
        injections:   [...definition.injections],
        responseType: 'stream',
      }), requestAbort.signal);
      upstreamHeadersMs = performance.now() - upstreamStartedAt;
      status = upstream.status;
      if (upstream.status === 423) recordVaultFailure('locked'); else recordVaultSuccess();
      if (upstream.status >= 400) {
        console.warn(`[ProviderCliBridge] upstream ${ definition.integration } ${ upstreamPath } returned ${ upstream.status }`);
      }
      response.writeHead(upstream.status, responseHeaders(upstream.headers));
      response.flushHeaders();
      if (upstream.body) {
        // Forward each chunk the moment it arrives (no pipeline buffering). A
        // client that disconnects mid-stream must not leave us waiting on a
        // drain that never comes, so back-pressure also settles on close.
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || response.destroyed) break;
            if (!firstChunkMs) firstChunkMs = performance.now() - startedAt;
            if (!response.write(value)) {
              await new Promise<void>(resolve => {
                const settle = () => { response.off('drain', settle); response.off('close', settle); resolve() };
                response.once('drain', settle);
                response.once('close', settle);
              });
            }
          }
        } finally {
          if (response.destroyed) await reader.cancel().catch(() => {});
        }
      }
      response.end();
    } catch (error) {
      const failure = classifyProviderBridgeFailure(error);
      const brokerStatus = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
      const vaultKind = vaultFailureKind(brokerStatus, failure.errorCode === 'vault_locked' ? 'vault_locked' : failure.reason);
      if (vaultKind) recordVaultFailure(vaultKind);
      failureNote = ` failure=${ failure.type }${ failure.errorCode ? `:${ failure.errorCode }` : '' }${ failure.reason ? ` reason=${ failure.reason }` : '' }`;
      console.error(`[ProviderCliBridge] request failed: ${ failure.errorName }${ failure.errorCode ? ` (${ failure.errorCode })` : '' }` +
        `${ failure.reason ? ` reason=${ failure.reason }` : '' } -> ${ failure.status } ${ failure.type }`);
      if (!response.headersSent) {
        status = failure.status;
        sendError(response, status, failure.type, failure.transient
          ? {
            message: 'Sulla provider bridge is temporarily unavailable',
            reason:  failure.reason,
            headers: {
              'retry-after':    String(PROVIDER_BRIDGE_RETRY_AFTER_SECONDS),
              'retry-after-ms': String(PROVIDER_BRIDGE_RETRY_AFTER_SECONDS * 1000),
              'x-should-retry': 'true',
            },
          }
          : { reason: failure.reason });
      }
      abort();
    } finally {
      lifetime.signal.removeEventListener('abort', abort);
      const ms = (value: number) => value.toFixed(1);
      options.logTiming?.(`[BridgeTiming] provider=${ definition.cli } path=${ timingPath } requestBodyReadMs=${ ms(requestBodyReadMs) } liveContextMs=${ ms(liveContextMs) } beforeUpstreamMs=${ ms(beforeUpstreamMs) } upstreamHeadersMs=${ ms(upstreamHeadersMs) } firstChunkMs=${ ms(firstChunkMs) } totalMs=${ ms(performance.now() - startedAt) } status=${ status } bodyBytes=${ bodyBytes }${ failureNote }`);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, listenHost, resolve);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Provider CLI bridge did not bind a TCP port');
  }
  const visibleHost = advertisedHost ?? listenHost;
  const visibleOrigin = options.advertisedOrigin?.(address.port) ?? `http://${ visibleHost }:${ address.port }`;
  const endpointBase = `${ visibleOrigin }${ scopedPrefix }`;
  // Codex's Responses provider appends `/responses`; Anthropic's SDK appends
  // `/v1/messages` to its base URL.
  const baseUrl = definition.cli === 'codex' ? `${ endpointBase }/v1` : endpointBase;
  const environment: Readonly<Record<string, string>> = definition.cli === 'codex'
    ? { SULLA_PROVIDER_BRIDGE_TOKEN: capability }
    : definition.authMode === 'oauth'
      ? { CLAUDE_CODE_OAUTH_TOKEN: capability, ANTHROPIC_BASE_URL: baseUrl }
      : { ANTHROPIC_API_KEY: capability, ANTHROPIC_BASE_URL: baseUrl };
  const config: ProviderCliOpaqueConfig = Object.freeze({
    opaqueConfigRef,
    baseUrl,
    environment: Object.freeze(environment),
    ...(definition.cli === 'codex'
      ? {
        codexConfigOverrides: Object.freeze([
          'model_provider="sulla"',
          'model_providers.sulla.name="Sulla Vault Broker"',
          `model_providers.sulla.base_url=${ JSON.stringify(baseUrl) }`,
          'model_providers.sulla.env_key="SULLA_PROVIDER_BRIDGE_TOKEN"',
          'model_providers.sulla.wire_api="responses"',
          'model_providers.sulla.requires_openai_auth=false',
        ]),
      }
      : {}),
  });

  let closed = false;
  return {
    config,
    signal: lifetime.signal,
    revoke,
    async close() {
      if (closed) return;
      closed = true;
      revoke();
      options.signal?.removeEventListener('abort', revoke);
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
