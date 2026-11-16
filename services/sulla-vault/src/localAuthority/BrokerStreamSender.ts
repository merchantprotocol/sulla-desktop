// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import type { ClientRequest } from 'node:http';

import type { BrokerExecuteRequest } from '../contracts.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { MAX_GIT_STREAM_BYTES, MAX_STREAM_BYTES } from './LocalAuthorityLimits.js';
import type { BrokerStreamSink, PreparedBrokerRequest } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';
import { StreamingRedactor } from './StreamingRedactor.js';
import { BrokerCredentialFields } from './BrokerCredentialFields.js';
import { BrokerHttpBody } from './BrokerHttpBody.js';

/**
 * Streams a prepared broker request to a sink: textual streams through the redactor, binary
 * (git) streams byte-for-byte, with the same redirect, encoding and size rules.
 * Moved verbatim from LocalVaultAuthority (E9); in-flight requests and generation live on the host.
 */
export class BrokerStreamSender {
  constructor(private readonly host: LocalAuthorityHost) {}

  async sendStream(
    prepared: PreparedBrokerRequest,
    input: BrokerExecuteRequest,
    sink: BrokerStreamSink,
  ): Promise<void> {
    const method = input.method.toUpperCase();
    const blockedRequestHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie', 'x-sulla-git-request-id']);
    const headers = Object.fromEntries(Object.entries(prepared.headers).filter(([name]) => !blockedRequestHeaders.has(name.toLowerCase())));
    headers['accept-encoding'] = 'identity';
    const streamLimit = input.operation === 'github.git' ? MAX_GIT_STREAM_BYTES : MAX_STREAM_BYTES;
    let payload: Buffer | undefined;
    if (prepared.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      payload = BrokerHttpBody.serializeBrokerBody(prepared.body);
      if (payload.byteLength > streamLimit) throw new LocalVaultError('request_too_large', 413, 'Broker request body is too large');
      headers['content-length'] = String(payload.byteLength);
    }
    const binary = input.responseType === 'binary-stream';
    const redactor = binary ? null : new StreamingRedactor(prepared.secrets);
    const requestedId = Object.entries(input.headers ?? {}).find(([name]) => name.toLowerCase() === 'x-sulla-git-request-id')?.[1];
    const requestId = typeof requestedId === 'string' && /^[0-9a-f-]{36}$/i.test(requestedId) ? requestedId : randomUUID();
    const startedAt = Date.now();
    let received = 0;
    let logged = false;
    let endedBy = 'unknown';
    let terminalReason: unknown;
    const target = new URL(prepared.target);
    const pathParts = target.pathname.split('/').filter(Boolean);
    const repository = target.hostname === 'github.com' && pathParts.length >= 2 ? `${ pathParts[0] }/${ pathParts[1].replace(/\.git$/, '') }` : 'unknown';
    const service = input.operation === 'github.git' ? (target.pathname.includes('git-receive-pack') ? 'receive-pack' : 'upload-pack') : input.operation;
    const logTermination = () => {
      if (logged) return;
      logged = true;
      const error = terminalReason instanceof Error ? { name: terminalReason.name, code: (terminalReason as NodeJS.ErrnoException).code, message: prepared.secrets.reduce((message, secret) => secret ? message.split(secret).join('[secret redacted]') : message, terminalReason.message) } : terminalReason;
      console.info(JSON.stringify({ component: 'vault.broker.stream', requestId, repository, service, startedAt: new Date(startedAt).toISOString(), bytesReceived: received, durationMs: Date.now() - startedAt, endedBy, ...(error ? { reason: error } : {}) }));
    };
    if (binary) console.info(JSON.stringify({ component: 'vault.broker.stream', requestId, repository, service, startedAt: new Date(startedAt).toISOString(), event: 'start' }));

    await new Promise<void>((resolve, reject) => {
      let started = false;
      let aborted = false;
      let current: ClientRequest | undefined;
      sink.onAbort(() => {
        aborted = true;
        endedBy = 'downstream-abort';
        terminalReason = 'broker client disconnected';
        current?.destroy(new LocalVaultError('upstream_failed', 499, 'Broker client disconnected'));
      });
      this.host.parts.upstream.openUpstream(prepared.target, {
        operation: input.operation,
        method,
        headers,
        timeoutMs: 120_000,
        payload,
        generation: prepared.generation,
        failureMessage: 'Broker upstream stream failed',
        timeoutError: () => new LocalVaultError('upstream_timeout', 504, 'Broker stream timed out'),
      }, {
        canRetry: () => !aborted && !started,
        onRequest: request => {
          current = request;
          if (aborted) request.destroy(new LocalVaultError('upstream_failed', 499, 'Broker client disconnected'));
        },
        onError: (_request, safe) => {
          if (endedBy === 'unknown') endedBy = safe instanceof Error && /timed out/i.test(safe.message) ? 'vault-timeout' : 'upstream-error';
          terminalReason = safe;
          if (started) {
            sink.destroy(safe);
            logTermination();
            resolve();
          } else {
            logTermination();
            reject(safe);
          }
        },
        onResponse: (request, response) => {
          if (prepared.generation !== this.host.generation) {
            response.destroy(new LocalVaultError('vault_locked', 423, 'Vault locked during request'));
            return;
          }
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location;
            if (typeof location === 'string' && this.host.brokerRedirectPolicy.allowsGitHubLogRedirect({
              operation: input.operation, integrationId: input.ref.integrationId, requestUrl: prepared.target,
              status: response.statusCode, location,
            })) {
              response.resume();
              started = true;
              sink.start(302, { location });
              this.host.inFlight.delete(request);
              sink.end();
              endedBy = 'upstream-redirect';
              logTermination();
              resolve();
              return;
            }
            response.resume();
            request.destroy(new LocalVaultError('redirect_denied', 403, 'Broker redirects are disabled'));
            return;
          }
          const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
          const contentEncoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
          if (contentEncoding && contentEncoding !== 'identity') {
            response.resume();
            request.destroy(new LocalVaultError('invalid_upstream_response', 502, `Compressed broker streams are not accepted (content-encoding: ${ contentEncoding })`));
            return;
          }
          const bodyless = BrokerHttpBody.streamResponseIsBodyless(method, response.statusCode ?? 0, response.headers['content-length']);
          // Untyped bodies still pass through the redactor; providers (chatgpt.com)
          // send untyped error replies, and blocking them hid the real status.
          if (!binary && !bodyless && contentType && !contentType.startsWith('text/') && !contentType.includes('json') && !contentType.includes('event-stream') && !contentType.includes('ndjson')) {
            response.resume();
            request.destroy(new LocalVaultError('invalid_upstream_response', 502, `Streaming adapter requires a textual upstream response (status: ${ response.statusCode ?? 'none' }, content-type: ${ contentType })`));
            return;
          }
          const blockedResponseHeaders = /^(set-cookie|cookie|authorization|proxy-authenticate|www-authenticate|x-api-key|content-length)$/i;
          const outputHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (!blockedResponseHeaders.test(name) && typeof value === 'string') outputHeaders[name] = BrokerCredentialFields.redact(value, prepared.secrets);
          }
          if (binary && typeof response.headers['content-length'] === 'string') outputHeaders['content-length'] = response.headers['content-length'];
          started = true;
          sink.start(response.statusCode ?? 502, outputHeaders);
          response.on('data', (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > streamLimit) {
              request.destroy(new LocalVaultError('response_too_large', 502, 'Broker stream exceeded the size limit'));
              return;
            }
            const output = redactor ? redactor.transform(chunk) : chunk;
            if (output.byteLength && !sink.write(output)) {
              response.pause();
              sink.onceDrain(() => response.resume());
            }
          });
          response.on('end', () => {
            try { this.host.requireGeneration(prepared.generation); } catch (error) { endedBy = 'vault-generation-change'; terminalReason = error; request.destroy(error as Error); return; }
            const tail = redactor?.flush();
            if (tail?.byteLength) sink.write(tail);
            this.host.inFlight.delete(request);
            sink.end();
            endedBy = 'upstream-end';
            logTermination();
            resolve();
          });
          response.on('error', error => { endedBy = 'upstream-response-error'; terminalReason = error; request.destroy(error); });
        },
      });
    });
  }
}
