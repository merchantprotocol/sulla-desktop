import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { requireConfiguredCredentialBroker } from './index';

import type { BrokerInjection, ToolExecutionContext, LocalVaultBrokerClient } from './index';

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
export type ProviderCliIntegration = 'anthropic' | 'codex' | 'openai';

interface ProviderDefinition {
  cli:         ProviderCliName;
  integration: ProviderCliIntegration;
  origin:      string;
  routes:      ReadonlyMap<string, string>;
  injections:  readonly BrokerInjection[];
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
  },
] as const;

export interface ProviderCliBridgeIdentity {
  context:   ToolExecutionContext;
  provider:  ProviderCliName;
  accountId: string;
  /** Optional exact model allowlist supplied by the lifecycle capability. */
  models?:   readonly string[];
}

export interface ProviderCliBridgeOptions extends ProviderCliBridgeIdentity {
  /**
   * Called before binding and before every request. It must consult live
   * lifecycle state. Returning a context renews short-lived caller claims.
   */
  authorize(identity: Readonly<ProviderCliBridgeIdentity>):
    boolean | ToolExecutionContext | Promise<boolean | ToolExecutionContext>;
  /** Abort owned by the job/process lifecycle. Aborting it revokes the lease and active stream. */
  signal?:         AbortSignal;
  broker?:         Pick<LocalVaultBrokerClient, 'executeStream' | 'requestFor'>;
  listenHost?:     string;
  /** Optional service hostname visible from the provider container. */
  advertisedHost?: string;
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
  if (!ctx.sub || !ctx.agent_id || !ctx.pod_id || !ctx.device_id || !ctx.thread_id || !ctx.job_id) {
    throw new Error('Provider CLI bridge requires live subject, agent, device, thread, and job identity');
  }
  const definition = PROVIDERS.find(candidate => candidate.cli === input.provider &&
    candidate.integration === ctx.credential_scope?.integration_id);
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

async function readJsonBody(request: http.IncomingMessage, signal: AbortSignal): Promise<unknown> {
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
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
}

function assertAdvertisedHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host)) {
    throw new Error('Provider CLI bridge advertised host must be a hostname without scheme, port, path, or credentials');
  }
  return host;
}

function sendError(response: http.ServerResponse, status: number, code: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { type: code, message: 'Provider bridge request denied' } }));
}

/**
 * Create one process-scoped HTTP adapter. The returned environment contains
 * only a random bridge capability; the provider credential stays in vault
 * authority custody and is injected into the final upstream request there.
 */
export async function createProviderCliBridge(options: ProviderCliBridgeOptions): Promise<ProviderCliBridgeLease> {
  const definition = assertIdentity(options);
  if (options.signal?.aborted) throw new Error('Provider CLI bridge lifecycle is already revoked');
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

  const server = http.createServer(async(request, response) => {
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
        sendError(response, 401, 'invalid_bridge_capability');
        return;
      }
      const incoming = new URL(request.url ?? '/', 'http://provider-bridge.invalid');
      if (request.method !== 'POST' || incoming.search || incoming.hash || !incoming.pathname.startsWith(scopedPrefix)) {
        sendError(response, 404, 'unsupported_provider_route');
        return;
      }
      const incomingPath = incoming.pathname.slice(scopedPrefix.length);
      const upstreamPath = definition.routes.get(incomingPath);
      if (!upstreamPath) {
        sendError(response, 404, 'unsupported_provider_route');
        return;
      }
      let context: ToolExecutionContext | undefined;
      try {
        context = await liveContext(options, identity);
      } catch {
        revoke();
        sendError(response, 403, 'provider_bridge_identity_changed');
        return;
      }
      if (!context) {
        revoke();
        sendError(response, 403, 'provider_bridge_revoked');
        return;
      }
      const body = await readJsonBody(request, requestAbort.signal);
      try {
        context = await liveContext(options, identity);
      } catch {
        revoke();
        sendError(response, 403, 'provider_bridge_identity_changed');
        return;
      }
      if (!context) {
        revoke();
        sendError(response, 403, 'provider_bridge_revoked');
        return;
      }
      if (!modelAllowed(body, identity.models)) {
        sendError(response, 403, 'provider_model_denied');
        return;
      }
      const headers = requestHeaders(request.headers);
      if (definition.integration === 'codex') {
        // These are routing metadata, not credentials. Bind them to trusted
        // lifecycle identity instead of accepting container-selected values.
        headers.originator = 'codex_cli_rs';
        headers['session-id'] = context.thread_id!;
        headers['thread-id'] = context.thread_id!;
      }
      const upstream = await broker.executeStream(broker.requestFor(context, {
        operation:    'provider.cli',
        ref:          { integrationId: definition.integration, accountId: options.accountId },
        url:          `${ definition.origin }${ upstreamPath }`,
        method:       'POST',
        headers,
        body,
        injections:   [...definition.injections],
        responseType: 'stream',
      }), requestAbort.signal);
      response.writeHead(upstream.status, responseHeaders(upstream.headers));
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as any), response);
      else response.end();
    } catch {
      abort();
      sendError(response, 502, 'provider_bridge_failed');
    } finally {
      lifetime.signal.removeEventListener('abort', abort);
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
  const visibleOrigin = `http://${ visibleHost }:${ address.port }`;
  const endpointBase = `${ visibleOrigin }${ scopedPrefix }`;
  // Codex's Responses provider appends `/responses`; Anthropic's SDK appends
  // `/v1/messages` to its base URL.
  const baseUrl = definition.cli === 'codex' ? `${ endpointBase }/v1` : endpointBase;
  const environment: Readonly<Record<string, string>> = definition.cli === 'codex'
    ? { SULLA_PROVIDER_BRIDGE_TOKEN: capability }
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
