// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import http from 'node:http';
import { ProviderModelPin } from './ProviderModelPin';
import { ProviderBridgeRevokedError, PROVIDER_BRIDGE_RETRY_AFTER_SECONDS, ProviderCliBridgeTools, ProviderCliBridgeResponsePolicy, ProviderCliBridgeFailurePolicy } from './providerCliBridge';
import { configuredVaultBrokerProvider } from './VaultBrokerServiceProvider';
import { vaultHealthMonitor, VaultHealthMonitor } from './vaultHealth';
import type { ToolExecutionContext } from './index';
import type { ProviderCliBridgeOptions, ProviderCliBridgeLease, ProviderCliBridgeIdentity } from './providerCliBridge';

const console = globalThis.console;

/**
 * Create one process-scoped HTTP adapter. The returned environment contains
 * only a random bridge capability; the provider credential stays in vault
 * authority custody and is injected into the final upstream request there.
 */
export class ProviderCliBridgeService {
  constructor(private readonly requireBroker = () => configuredVaultBrokerProvider.requireConfiguredCredentialBroker()) {}

  async create(options: ProviderCliBridgeOptions): Promise<ProviderCliBridgeLease> {
  const definition = ProviderCliBridgeTools.assertIdentity(options);
  if (options.signal?.aborted) throw new ProviderBridgeRevokedError();
  const advertisedHost = options.advertisedHost ? ProviderCliBridgeTools.assertAdvertisedHost(options.advertisedHost) : undefined;
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
      if (lifetime.signal.aborted || !ProviderCliBridgeTools.safeEqual(ProviderCliBridgeTools.requestCapability(request), capability)) {
        status = 401;
        ProviderCliBridgeResponsePolicy.sendError(response, status, 'invalid_bridge_capability');
        return;
      }
      const incoming = new URL(request.url ?? '/', 'http://provider-bridge.invalid');
      if (request.method !== 'POST' || incoming.hash || !incoming.pathname.startsWith(scopedPrefix)) {
        status = 404;
        ProviderCliBridgeResponsePolicy.sendError(response, status, 'unsupported_provider_route');
        return;
      }
      const incomingPath = incoming.pathname.slice(scopedPrefix.length);
      const upstreamPath = definition.routes[incomingPath];
      timingPath = incomingPath;
      const upstreamSearch = definition.cli === 'claude-code' && incoming.search === '?beta=true'
        ? incoming.search
        : '';
      if (!upstreamPath || (incoming.search && !upstreamSearch)) {
        status = 404;
        ProviderCliBridgeResponsePolicy.sendError(response, status, 'unsupported_provider_route');
        return;
      }
      const initialContextStartedAt = performance.now();
      let context: ToolExecutionContext | undefined;
      try {
        context = await ProviderCliBridgeTools.liveContext(options, identity);
      } catch {
        liveContextMs = performance.now() - initialContextStartedAt;
        revoke();
        status = 403;
        ProviderCliBridgeResponsePolicy.sendError(response, status, 'provider_bridge_identity_changed');
        return;
      }
      liveContextMs = performance.now() - initialContextStartedAt;
      if (!context) {
        revoke();
        status = 403;
        ProviderCliBridgeResponsePolicy.sendError(response, status, 'provider_bridge_revoked');
        return;
      }
      const bodyStartedAt = performance.now();
      const bodyResult = await ProviderCliBridgeTools.readJsonBody(request, requestAbort.signal);
      requestBodyReadMs = performance.now() - bodyStartedAt;
      bodyBytes = bodyResult.bytes;

      const contextStartedAt = performance.now();
      try {
        context = await ProviderCliBridgeTools.liveContext(options, identity);
      } catch {
        liveContextMs += performance.now() - contextStartedAt;
        revoke();
        status = 403;
        ProviderCliBridgeResponsePolicy.sendError(response, status, 'provider_bridge_identity_changed');
        return;
      }
      liveContextMs += performance.now() - contextStartedAt;
      if (!context) {
        revoke();
        status = 403;
        ProviderCliBridgeResponsePolicy.sendError(response, status, 'provider_bridge_revoked');
        return;
      }
      if (!ProviderCliBridgeTools.modelAllowed(bodyResult.body, identity.models)) {
        status = 403;
        // Model names only (no secrets): says which pin refused which request.
        ProviderCliBridgeResponsePolicy.sendError(response, status, 'provider_model_denied', { reason: `requested=${ String(ProviderModelPin.requested(bodyResult.body) ?? '(none)') } allowed=${ (identity.models ?? []).join(',') }` });
        return;
      }
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
      if (upstream.status === 423) vaultHealthMonitor.record('locked'); else vaultHealthMonitor.recordSuccess();
      if (upstream.status >= 400) {
        console.warn(`[ProviderCliBridge] upstream ${ definition.integration } ${ upstreamPath } returned ${ upstream.status }`);
      }
      response.writeHead(upstream.status, ProviderCliBridgeTools.responseHeaders(upstream.headers));
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
      const failure = ProviderCliBridgeFailurePolicy.classifyProviderBridgeFailure(error);
      const brokerStatus = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
      const vaultKind = VaultHealthMonitor.failureKind(brokerStatus, failure.errorCode === 'vault_locked' ? 'vault_locked' : failure.reason);
      if (vaultKind) vaultHealthMonitor.record(vaultKind);
      failureNote = ` failure=${ failure.type }${ failure.errorCode ? `:${ failure.errorCode }` : '' }${ failure.reason ? ` reason=${ failure.reason }` : '' }`;
      console.error(`[ProviderCliBridge] request failed: ${ failure.errorName }${ failure.errorCode ? ` (${ failure.errorCode })` : '' }` +
        `${ failure.reason ? ` reason=${ failure.reason }` : '' } -> ${ failure.status } ${ failure.type }`);
      if (!response.headersSent) {
        status = failure.status;
        ProviderCliBridgeResponsePolicy.sendError(response, status, failure.type, failure.transient
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
}
