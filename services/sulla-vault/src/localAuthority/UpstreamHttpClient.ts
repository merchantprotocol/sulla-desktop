// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { promises as dns } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';

import type { BrokerExecuteResponse } from '../contracts.js';
import { pinnedAddressesLookup, pinnedLookup, type PinnedAddress } from '../pinnedLookup.js';
import {
  describeUpstreamError, familySummary, formatUpstreamFailureLog, isReconnectableUpstreamError, retryAddressOrder,
  UPSTREAM_CONNECT_TIMEOUT_MS, UPSTREAM_FIRST_ATTEMPT_FAMILY_TIMEOUT_MS, UPSTREAM_MAX_ATTEMPTS,
  UPSTREAM_RETRY_ATTEMPT_FAMILY_TIMEOUT_MS, UPSTREAM_RETRY_DELAYS_MS,
  upstreamFailurePhase, upstreamFailureReason,
} from '../upstreamEgress.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { MAX_RESPONSE_BYTES } from './LocalAuthorityLimits.js';
import { LocalVaultError } from './LocalVaultError.js';
import { BrokerAddressPolicy } from './BrokerAddressPolicy.js';
import { BrokerCredentialFields } from './BrokerCredentialFields.js';
import { BrokerHttpBody } from './BrokerHttpBody.js';

/**
 * Pinned, SSRF-checked HTTPS to broker upstreams: DNS validation, connect-phase retries on a
 * fresh socket, and the buffered request/response path with redaction and size limits.
 * Moved verbatim from LocalVaultAuthority (E9); in-flight requests and generation live on the host.
 */
export class UpstreamHttpClient {
  constructor(private readonly host: LocalAuthorityHost) {}

  async validateTarget(raw: string): Promise<URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses: PinnedAddress[] }> {
    let url: URL;
    try { url = new URL(raw); } catch { throw new LocalVaultError('invalid_destination', 400, 'Destination URL is invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new LocalVaultError('invalid_destination', 403, 'Destination must be HTTPS without credentials or fragments');
    }
    const pinnedAddresses = await this.resolvePinnedAddresses(url.hostname);
    return Object.assign(url, {
      pinnedAddress: pinnedAddresses[0].address,
      pinnedFamily: pinnedAddresses[0].family,
      pinnedAddresses,
    });
  }

  /**
   * Resolve and validate public addresses. Called per request (and again for
   * a connect retry); nothing is cached across requests, so a network change
   * never leaves a stale pin behind.
   */
  private async resolvePinnedAddresses(hostname: string, attempt = 1): Promise<PinnedAddress[]> {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      const detail = describeUpstreamError(error);
      const willRetry = detail.code === 'EAI_AGAIN' && attempt < UPSTREAM_MAX_ATTEMPTS;
      console.warn(formatUpstreamFailureLog({
        operation: 'dns.lookup', hostname, attempt, maxAttempts: UPSTREAM_MAX_ATTEMPTS, phase: 'dns', detail,
        families: 'none', reusedSocket: false, willRetry,
      }));
      if (willRetry) {
        await new Promise(resolve => setTimeout(resolve, UPSTREAM_RETRY_DELAYS_MS[attempt - 1]));
        return this.resolvePinnedAddresses(hostname, attempt + 1);
      }
      throw new LocalVaultError('upstream_failed', 502, 'Broker upstream DNS lookup failed', upstreamFailureReason('dns', detail.code));
    }
    if (!addresses.length || addresses.some(candidate => BrokerAddressPolicy.privateAddress(candidate.address))) {
      throw new LocalVaultError('destination_denied', 403, 'Destination resolved to a private, local, or invalid address');
    }
    return addresses.map(candidate => ({ address: candidate.address, family: candidate.family as 4 | 6 }));
  }

  /**
   * Open one upstream HTTPS request with connect-phase self-healing.
   *
   * A failure before the TLS handshake completes on a fresh socket means no
   * request bytes reached the upstream, so it is safe to re-resolve DNS and
   * try twice more (other address family first). Reused keep-alive sockets and
   * failures after the handshake are never retried. Every failure is logged
   * with its errno/syscall/family and surfaces a non-secret reason code.
   */
  openUpstream(
    target: URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses?: PinnedAddress[] },
    options: {
      operation:  string;
      method:     string;
      headers:    Record<string, string>;
      timeoutMs:  number;
      payload?:   Buffer;
      generation: number;
      failureMessage: string;
      timeoutError: () => LocalVaultError;
      signal?: AbortSignal;
    },
    hooks: {
      onRequest(request: ClientRequest): void;
      onResponse(request: ClientRequest, response: IncomingMessage): void;
      onError(request: ClientRequest, error: LocalVaultError): void;
      canRetry?(): boolean;
    },
  ): void {
    const maxAttempts = UPSTREAM_MAX_ATTEMPTS;
    const start = (addresses: PinnedAddress[], attempt: number) => {
      let connected = false;
      let reusedSocket = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const clearConnectTimer = () => { if (connectTimer) clearTimeout(connectTimer); connectTimer = undefined };
      this.host.requireGeneration(options.generation);
      // Family-autoselection fields are honoured by net.connect but missing from http's option types.
      const requestOptions: https.RequestOptions & { autoSelectFamily?: boolean; autoSelectFamilyAttemptTimeout?: number } = {
        protocol: 'https:',
        hostname: target.hostname,
        servername: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${ target.pathname }${ target.search }`,
        method: options.method,
        headers: options.headers,
        timeout: options.timeoutMs,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: attempt === 1 ? UPSTREAM_FIRST_ATTEMPT_FAMILY_TIMEOUT_MS : UPSTREAM_RETRY_ATTEMPT_FAMILY_TIMEOUT_MS,
        lookup: addresses.length ? pinnedAddressesLookup(addresses) : pinnedLookup(target.pinnedAddress, target.pinnedFamily),
      };
      const request = https.request(requestOptions, response => hooks.onResponse(request, response));
      this.host.inFlight.add(request);
      hooks.onRequest(request);
      request.on('socket', socket => {
        if (request.reusedSocket) {
          connected = true;
          reusedSocket = true;
          return;
        }
        connectTimer = setTimeout(() => {
          request.destroy(Object.assign(new Error('Upstream connect timed out'), { code: 'UPSTREAM_CONNECT_TIMEOUT', syscall: 'connect' }));
        }, UPSTREAM_CONNECT_TIMEOUT_MS);
        connectTimer.unref?.();
        socket.once('secureConnect', () => { connected = true; clearConnectTimer() });
        socket.once('close', clearConnectTimer);
      });
      request.on('timeout', () => request.destroy(options.timeoutError()));
      request.on('error', error => {
        clearConnectTimer();
        this.host.inFlight.delete(request);
        if (error instanceof LocalVaultError) {
          hooks.onError(request, error);
          return;
        }
        const detail = describeUpstreamError(error);
        const phase = upstreamFailurePhase(detail.code, connected);
        const reason = upstreamFailureReason(phase, detail.code === 'UPSTREAM_CONNECT_TIMEOUT' ? 'timeout' : detail.code);
        const willRetry = attempt < maxAttempts && isReconnectableUpstreamError(error, connected) && (hooks.canRetry?.() ?? true);
        console.warn(formatUpstreamFailureLog({
          operation: options.operation, hostname: target.hostname, attempt, maxAttempts, phase, detail,
          families: familySummary(addresses), reusedSocket, willRetry,
        }));
        const failure = new LocalVaultError('upstream_failed', 502, options.failureMessage, reason);
        if (!willRetry) {
          hooks.onError(request, failure);
          return;
        }
        this.resolvePinnedAddresses(target.hostname).then(fresh => {
          if (!(hooks.canRetry?.() ?? true)) {
            hooks.onError(request, failure);
            return;
          }
          const retryAddresses = retryAddressOrder(fresh, detail.attempts.length ? detail.attempts : addresses.map(candidate => `v${ candidate.family }:${ detail.code }`));
          setTimeout(() => {
            if (!(hooks.canRetry?.() ?? true)) {
              hooks.onError(request, failure);
              return;
            }
            try {
              start(retryAddresses, attempt + 1);
            } catch (retryError) {
              hooks.onError(request, retryError instanceof LocalVaultError ? retryError : failure);
            }
          }, UPSTREAM_RETRY_DELAYS_MS[attempt - 1]);
        }).catch(resolveError => {
          hooks.onError(request, resolveError instanceof LocalVaultError ? resolveError : failure);
        });
      });
      const onAbort = () => request.destroy(new LocalVaultError('invalid_operation', 400, 'Broker request cancelled'));
      const removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        request.once('close', removeAbortListener);
        if (options.signal.aborted) {
          onAbort();
          return;
        }
      }
      if (options.payload) request.write(options.payload);
      request.end();
    };
    start(target.pinnedAddresses?.length ? [...target.pinnedAddresses] : [], 1);
  }

  async send(
    url: URL & { pinnedAddress: string; pinnedFamily: 4 | 6; pinnedAddresses?: PinnedAddress[] },
    methodInput: string,
    headersInput: Record<string, string>,
    bodyInput: unknown,
    responseType: 'json' | 'text' | 'base64',
    secrets: string[],
    generation: number,
    redactResponseBody = true,
    maxRequestBytes = MAX_RESPONSE_BYTES,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    operation = 'broker.request',
    integrationId?: string,
    signal?: AbortSignal,
  ): Promise<BrokerExecuteResponse> {
    const method = methodInput.toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new LocalVaultError('method_denied', 403, 'HTTP method is not allowed');
    }
    const blockedRequestHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie']);
    const headers = Object.fromEntries(Object.entries(headersInput).filter(([name]) => !blockedRequestHeaders.has(name.toLowerCase())));
    headers['accept-encoding'] = 'identity';
    let payload: Buffer | undefined;
    if (bodyInput !== undefined && method !== 'GET' && method !== 'HEAD') {
      payload = BrokerHttpBody.serializeBrokerBody(bodyInput);
      if (payload.byteLength > maxRequestBytes) throw new LocalVaultError('request_too_large', 413, 'Broker request body is too large');
      headers['content-length'] = String(payload.byteLength);
      if (!BrokerHttpBody.headerValue(headers, 'content-type')) {
        headers['content-type'] = Buffer.isBuffer(bodyInput)
          ? 'application/octet-stream'
          : bodyInput instanceof URLSearchParams ? 'application/x-www-form-urlencoded'
            : typeof bodyInput === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
      }
    }

    return new Promise<BrokerExecuteResponse>((resolve, reject) => {
      this.openUpstream(url, {
        operation: 'broker.request',
        method,
        headers,
        timeoutMs: 30_000,
        payload,
        generation,
        failureMessage: 'Broker upstream request failed',
        timeoutError: () => new LocalVaultError('upstream_timeout', 504, 'Broker request timed out'),
        signal,
      }, {
        onRequest: () => undefined,
        onError: (_request, error) => reject(error),
        onResponse: (request, response) => {
          if (generation !== this.host.generation) {
            response.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
            return;
          }
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location;
            if (typeof location === 'string' && this.host.brokerRedirectPolicy.allowsGitHubLogRedirect({
              operation, integrationId, requestUrl: url,
              status: response.statusCode, location,
            })) {
              response.resume();
              this.host.inFlight.delete(request);
              resolve({ status: 302, headers: { location }, body: '' });
              return;
            }
            response.resume();
            reject(new LocalVaultError('redirect_denied', 403, 'Broker redirects are disabled'));
            return;
          }
          const contentEncoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
          if (contentEncoding && contentEncoding !== 'identity') {
            response.resume();
            request.destroy(new LocalVaultError('invalid_upstream_response', 502, 'Compressed broker responses are not accepted'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > maxResponseBytes) request.destroy(new LocalVaultError('response_too_large', 502, 'Broker response exceeded the size limit'));
            else chunks.push(chunk);
          });
          response.on('end', () => {
            try { this.host.requireGeneration(generation); } catch (error) { reject(error); return; }
            if (responseType === 'base64') {
              // Binary bodies cannot be redacted in place, so one that echoes a credential is refused outright.
              const bytes = Buffer.concat(chunks);
              if (secrets.some(secret => secret && bytes.includes(Buffer.from(secret)))) {
                reject(new LocalVaultError('invalid_upstream_response', 502, 'Upstream response echoed a credential'));
                return;
              }
              const binaryHeaders: Record<string, string> = {};
              for (const name of ['content-type', 'content-length', 'x-content-sha256']) {
                const value = response.headers[name];
                if (typeof value === 'string') binaryHeaders[name] = value;
              }
              this.host.inFlight.delete(request);
              resolve({ status: response.statusCode ?? 502, headers: binaryHeaders, body: bytes.toString('base64') });
              return;
            }
            const upstream = Buffer.concat(chunks).toString('utf8');
            const raw = redactResponseBody ? BrokerCredentialFields.redact(upstream, secrets) : upstream;
            const blockedResponseHeaders = /^(set-cookie|cookie|authorization|proxy-authenticate|www-authenticate|x-api-key)$/i;
            const outputHeaders: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (!blockedResponseHeaders.test(name) && typeof value === 'string') outputHeaders[name] = BrokerCredentialFields.redact(value, secrets);
            }
            let body: unknown = raw;
            if (responseType === 'json' && raw) {
              // Error responses are often plain text; keep them so the caller sees the real HTTP status.
              const ok = (response.statusCode ?? 502) >= 200 && (response.statusCode ?? 502) < 300;
              try { body = JSON.parse(raw); } catch {
                if (ok) { reject(new LocalVaultError('invalid_upstream_response', 502, 'Expected a JSON response')); return; }
              }
            }
            this.host.inFlight.delete(request);
            resolve({ status: response.statusCode ?? 502, headers: outputHeaders, body });
          });
        },
        canRetry: () => !signal?.aborted,
      });
    });
  }
}
