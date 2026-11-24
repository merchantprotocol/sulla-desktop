// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import http from 'node:http';
import { PROVIDER_BRIDGE_RETRY_AFTER_SECONDS, ProviderBridgeAuthorizeUnavailableError, ProviderBridgeRequestError } from './ProviderBridgeErrors';
import { ProviderBridgeRevokedError, ProviderCliBridgeTools, ProviderCliBridgeResponsePolicy, ProviderCliBridgeFailurePolicy } from './providerCliBridge';
import { configuredVaultBrokerProvider } from './VaultBrokerServiceProvider';
import { vaultHealthMonitor, VaultHealthMonitor } from './vaultHealth';
import type { ToolExecutionContext } from './index';
import type { ProviderCliBridgeOptions, ProviderCliBridgeLease, ProviderCliBridgeIdentity, ProviderCliOpaqueConfig } from './providerCliBridge';
import { providerBridgeActivity } from './ProviderBridgeActivity';

const console = globalThis.console;
const RETRY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'retry-after':    String(PROVIDER_BRIDGE_RETRY_AFTER_SECONDS),
  'retry-after-ms': String(PROVIDER_BRIDGE_RETRY_AFTER_SECONDS * 1000),
  'x-should-retry': 'true',
});
const UNAVAILABLE_MESSAGE = 'Sulla provider bridge is temporarily unavailable';
const MAX_PROVIDER_ERROR_BODY_BYTES = 8 * 1024;
const MAX_PROVIDER_REASON_CHARS = 240;

/**
 * Create one process-scoped HTTP adapter. The returned environment contains
 * only a random bridge capability; the provider credential stays in vault
 * authority custody and is injected into the final upstream request there.
 */
export class ProviderCliBridgeService {
  constructor(private readonly requireBroker = () => configuredVaultBrokerProvider.requireConfiguredCredentialBroker()) {}

  private retryAfterSeconds(header: string | null): number | undefined {
    const value = header?.trim();
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 24 * 60 * 60);
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return undefined;
    return Math.min(Math.max(Math.ceil((date - Date.now()) / 1000), 0), 24 * 60 * 60);
  }

  private openAIErrorReason(chunks: readonly Buffer[], byteCount: number): string | undefined {
    if (byteCount === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat([...chunks], byteCount).toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const body = parsed as Record<string, unknown>;
    const providerError = body.error;
    const message = providerError && typeof providerError === 'object' && !Array.isArray(providerError)
      ? (providerError as Record<string, unknown>).message
      : body.message;
    if (typeof message !== 'string' || !message.trim()) return undefined;
    return this.safeOpenAIReason(message);
  }

  private safeOpenAIReason(reason: string): string | undefined {
    const safe = reason
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
      .replace(/\borg-[A-Za-z0-9]{8,}\b/g, '[redacted]')
      .replace(/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
      .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
      .replace(/\s+/g, ' ')
      .trim();
    if (!safe) return undefined;
    return safe.length > MAX_PROVIDER_REASON_CHARS
      ? `${ safe.slice(0, MAX_PROVIDER_REASON_CHARS - 1) }…`
      : safe;
  }

  async create(options: ProviderCliBridgeOptions): Promise<ProviderCliBridgeLease> {
  const definition = ProviderCliBridgeTools.assertIdentity(options);
  if (options.signal?.aborted) throw new ProviderBridgeRevokedError();
  const advertisedHost = options.advertisedHost ? ProviderCliBridgeTools.assertAdvertisedHost(options.advertisedHost) : undefined;
  const listenHost = options.listenHost ?? (advertisedHost ? '0.0.0.0' : '127.0.0.1');
  if (!advertisedHost && ['0.0.0.0', '::'].includes(listenHost)) {
    throw new Error('Provider CLI bridge requires an advertised service hostname for a non-loopback listener');
  }
  const identity: Readonly<ProviderCliBridgeIdentity> = Object.freeze({
    context:   options.context,
    provider:  options.provider,
    accountId: options.accountId,
    authMode:  options.authMode,
  });
  if (!await ProviderCliBridgeTools.liveContext(options, identity)) throw new Error('Provider CLI bridge identity is not active');

  const broker = options.broker ?? this.requireBroker();
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
    let retryAfterSeconds: number | undefined;
    let openAIReason: string | undefined;
    let timingPath = 'unknown';
    let failureNote = '';
    // Where the request was when it failed; part of the logged reason code.
    let stage = 'request';
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
    const deny = (code: number, type: string, extra: { message?: string; reason: string; headers?: Record<string, string> }) => {
      status = code;
      failureNote = ` failure=${ type } reason=${ extra.reason } stage=${ stage }`;
      ProviderCliBridgeResponsePolicy.sendError(response, code, type, extra);
    };
    // Revoking destroys every in-flight request, including this one; detach it
    // first so the CLI receives the denial and its reason, not a socket reset.
    const revokeAfterReply = () => {
      lifetime.signal.removeEventListener('abort', abort);
      revoke();
    };
    // Live lifecycle check. A check that could not run (Redis blip) is
    // transient and must not revoke the lease; only a real refusal or
    // identity mismatch does.
    const checkLive = async(): Promise<ToolExecutionContext | undefined> => {
      const checkStartedAt = performance.now();
      try {
        const live = await ProviderCliBridgeTools.liveContext(options, identity);
        if (!live) {
          deny(403, 'provider_bridge_revoked', { reason: 'authorize_refused' });
          revokeAfterReply();
        }
        return live;
      } catch (error) {
        const reason = ProviderCliBridgeFailurePolicy.denialReason(error);
        // Only the typed "check could not run" error keeps the lease; any other
        // throw (even one that claims to be retryable) is a refusal.
        if (error instanceof ProviderBridgeAuthorizeUnavailableError) {
          deny(503, 'provider_bridge_unavailable', { message: UNAVAILABLE_MESSAGE, reason, headers: { ...RETRY_HEADERS } });
          return undefined;
        }
        deny(403, 'provider_bridge_identity_changed', { reason });
        revokeAfterReply();
        return undefined;
      } finally {
        liveContextMs += performance.now() - checkStartedAt;
      }
    };

    try {
      if (lifetime.signal.aborted || !ProviderCliBridgeTools.safeEqual(ProviderCliBridgeTools.requestCapability(request), capability)) {
        deny(401, 'invalid_bridge_capability', { reason: lifetime.signal.aborted ? 'lifecycle_revoked' : 'capability_mismatch' });
        return;
      }
      const incoming = new URL(request.url ?? '/', 'http://provider-bridge.invalid');
      if (request.method !== 'POST' || incoming.hash || !incoming.pathname.startsWith(scopedPrefix)) {
        deny(404, 'unsupported_provider_route', { reason: request.method !== 'POST' ? 'method_not_post' : 'scope_prefix_mismatch' });
        return;
      }
      const incomingPath = incoming.pathname.slice(scopedPrefix.length);
      const upstreamPath = definition.routes[incomingPath];
      timingPath = incomingPath;
      const upstreamSearch = definition.cli === 'claude-code' && incoming.search === '?beta=true'
        ? incoming.search
        : '';
      if (!upstreamPath || (incoming.search && !upstreamSearch)) {
        deny(404, 'unsupported_provider_route', { reason: upstreamPath ? 'query_not_allowed' : 'route_not_allowed' });
        return;
      }
      stage = 'authorize';
      if (!await checkLive()) return;
      stage = 'request_body';
      const bodyStartedAt = performance.now();
      const bodyResult = await ProviderCliBridgeTools.readJsonBody(request, requestAbort.signal);
      requestBodyReadMs = performance.now() - bodyStartedAt;
      bodyBytes = bodyResult.bytes;

      stage = 'authorize';
      const context = await checkLive();
      if (!context) return;
      const headers = ProviderCliBridgeTools.requestHeaders(request.headers);
      const workspaceId = options.workspaceId?.trim();
      if (definition.cli === 'claude-code' && definition.authMode === 'api-key' && workspaceId) {
        headers['anthropic-workspace-id'] = workspaceId;
      }
      if (definition.integration === 'codex') {
        headers.originator = 'codex_cli_rs';
        headers['session-id'] = context.thread_id!;
        headers['thread-id'] = context.thread_id!;
      }
      stage = 'credential_upkeep';
      const upkeepStartedAt = performance.now();
      try {
        await runBeforeUpstream();
      } catch (error) {
        // Upkeep is a best-effort early refresh; the stored credential is
        // usually still valid. Failing the request here surfaced as a
        // terminal "request denied" and killed healthy workers. A credential
        // that really expired gets the provider's own 401 instead.
        failureNote = ' upkeep=credential_upkeep_failed';
        console.warn(`[ProviderCliBridge] credential upkeep failed reason=credential_upkeep_failed error=${ ProviderCliBridgeFailurePolicy.safeToken((error as { name?: unknown })?.name) ?? 'Error' }; forwarding with the stored credential`);
      }
      beforeUpstreamMs = performance.now() - upkeepStartedAt;
      stage = 'upstream_headers';
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
      providerBridgeActivity.mark(identity.context.pod_id);
      status = upstream.status;
      const captureProviderReason = definition.cli === 'codex' && (status === 429 || status === 503);
      if (captureProviderReason) {
        retryAfterSeconds = this.retryAfterSeconds(upstream.headers.get('retry-after'));
        providerBridgeActivity.publishRetryStatus(identity.context.pod_id, {
          status: status as 429 | 503,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        });
      }
      if (upstream.status === 423) vaultHealthMonitor.record('locked'); else vaultHealthMonitor.recordSuccess();
      if (upstream.status >= 400) {
        console.warn(`[ProviderCliBridge] upstream ${ definition.integration } ${ upstreamPath } returned ${ upstream.status }`);
      }
      response.writeHead(upstream.status, ProviderCliBridgeTools.responseHeaders(upstream.headers));
      response.flushHeaders();
      stage = 'upstream_stream';
      if (upstream.body) {
        // Forward each chunk the moment it arrives (no pipeline buffering). A
        // client that disconnects mid-stream must not leave us waiting on a
        // drain that never comes, so back-pressure also settles on close.
        const reader = upstream.body.getReader();
        const providerErrorChunks: Buffer[] = [];
        let providerErrorBytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || response.destroyed) break;
            providerBridgeActivity.mark(identity.context.pod_id);
            // Model output (reasoning included) keeps the run's stall clock alive; error bodies do not.
            if (status < 400) providerBridgeActivity.markModelOutput(identity.context.pod_id);
            if (captureProviderReason && providerErrorBytes < MAX_PROVIDER_ERROR_BODY_BYTES) {
              const availableBytes = MAX_PROVIDER_ERROR_BODY_BYTES - providerErrorBytes;
              const captured = Buffer.from(value.subarray(0, availableBytes));
              providerErrorChunks.push(captured);
              providerErrorBytes += captured.byteLength;
            }
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
        if (captureProviderReason) {
          openAIReason = this.openAIErrorReason(providerErrorChunks, providerErrorBytes);
          if (openAIReason) providerBridgeActivity.publishRetryStatus(identity.context.pod_id, {
            status: status as 429 | 503,
            reason: openAIReason,
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
          });
        }
      }
      response.end();
    } catch (error) {
      if (requestAbort.signal.aborted) {
        // The CLI hung up or the job's lifecycle ended: a cancellation, not a bridge failure.
        const reason = lifetime.signal.aborted ? 'lifecycle_revoked' : 'client_disconnected';
        if (!response.headersSent && !response.destroyed) deny(403, 'provider_bridge_revoked', { reason });
        else {
          status = 499;
          // The streamed reply can never finish; end the connection so the CLI
          // sees the cut instead of waiting on an open socket. request.destroy()
          // alone leaves the socket up once the request body was fully read.
          response.destroy();
        }
        failureNote = ` failure=provider_bridge_cancelled reason=${ reason } stage=${ stage }`;
        console.warn(`[ProviderCliBridge] request cancelled reason=${ reason } stage=${ stage }`);
        return;
      }
      if (error instanceof ProviderBridgeRequestError) {
        deny(error.status, 'invalid_provider_request', { reason: error.reason });
        return;
      }
      const failure = ProviderCliBridgeFailurePolicy.classifyProviderBridgeFailure(error, stage);
      const brokerStatus = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
      const vaultKind = VaultHealthMonitor.failureKind(brokerStatus, failure.errorCode === 'vault_locked' ? 'vault_locked' : failure.reason);
      if (vaultKind) vaultHealthMonitor.record(vaultKind);
      failureNote = ` failure=${ failure.type }${ failure.errorCode ? `:${ failure.errorCode }` : '' }${ failure.reason ? ` reason=${ failure.reason }` : '' } stage=${ stage }`;
      console.error(`[ProviderCliBridge] request failed: ${ failure.errorName }${ failure.errorCode ? ` (${ failure.errorCode })` : '' }` +
        `${ failure.reason ? ` reason=${ failure.reason }` : '' } -> ${ failure.status } ${ failure.type }`);
      if (!response.headersSent) {
        status = failure.status;
        ProviderCliBridgeResponsePolicy.sendError(response, status, failure.type, failure.transient
          ? { message: UNAVAILABLE_MESSAGE, reason: failure.reason, headers: { ...RETRY_HEADERS } }
          : { reason: failure.reason });
      }
      // Destroying the request also destroys its socket: let a written error reply flush first.
      if (response.writableEnded && !response.writableFinished) response.once('finish', abort);
      else abort();
    } finally {
      lifetime.signal.removeEventListener('abort', abort);
      const ms = (value: number) => value.toFixed(1);
      options.logTiming?.(`[BridgeTiming] provider=${ definition.cli } path=${ timingPath } requestBodyReadMs=${ ms(requestBodyReadMs) } liveContextMs=${ ms(liveContextMs) } beforeUpstreamMs=${ ms(beforeUpstreamMs) } upstreamHeadersMs=${ ms(upstreamHeadersMs) } firstChunkMs=${ ms(firstChunkMs) } totalMs=${ ms(performance.now() - startedAt) } status=${ status } bodyBytes=${ bodyBytes }${ retryAfterSeconds !== undefined ? ` retry_after=${ retryAfterSeconds }s` : '' }${ openAIReason ? ` openai_reason=${ JSON.stringify(openAIReason) }` : '' }${ failureNote }`);
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
}
