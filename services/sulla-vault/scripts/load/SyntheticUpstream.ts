// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';

export interface SyntheticUpstreamSnapshot {
  activeStreams: number;
  maxConcurrentStreams: number;
  totalStreamRequests: number;
  totalShortRequests: number;
  requestBodyBytes: number;
  maxRequestBodyBytes: number;
  upstreamRequestAtNs: Record<string, string>;
  tlsConnectedAtNs: Record<string, string>;
}

/** HTTPS-only upstream that records synthetic load and emits no logs or credential material. */
export class SyntheticUpstream {
  private server?: Server;
  private active = 0;
  private maximum = 0;
  private streamRequests = 0;
  private shortRequests = 0;
  private totalBodyBytes = 0;
  private maxBodyBytes = 0;
  private readonly requestAtNs = new Map<string, string>();
  private readonly tlsAtNs = new Map<string, string>();
  private readonly tlsReadyAtNs = new WeakMap<TLSSocket, bigint>();

  constructor(
    private readonly certificate: Buffer,
    private readonly privateKey: Buffer,
  ) {}

  async start(): Promise<{ origin: string; port: number }> {
    const server = createServer({ cert: this.certificate, key: this.privateKey }, (request, response) => this.handle(request, response));
    this.server = server;
    server.on('secureConnection', socket => this.tlsReadyAtNs.set(socket, process.hrtime.bigint()));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic upstream did not bind a TCP port');
    return { origin: `https://api.openai.com:${ address.port }`, port: address.port };
  }

  snapshot(): SyntheticUpstreamSnapshot {
    return {
      activeStreams: this.active,
      maxConcurrentStreams: this.maximum,
      totalStreamRequests: this.streamRequests,
      totalShortRequests: this.shortRequests,
      requestBodyBytes: this.totalBodyBytes,
      maxRequestBodyBytes: this.maxBodyBytes,
      upstreamRequestAtNs: Object.fromEntries(this.requestAtNs),
      tlsConnectedAtNs: Object.fromEntries(this.tlsAtNs),
    };
  }

  reset(): void {
    if (this.active !== 0) throw new Error('Cannot reset upstream metrics while streams remain open');
    this.maximum = 0;
    this.streamRequests = 0;
    this.shortRequests = 0;
    this.totalBodyBytes = 0;
    this.maxBodyBytes = 0;
    this.requestAtNs.clear();
    this.tlsAtNs.clear();
  }

  resetPeak(): void {
    if (this.active !== 0) throw new Error('Cannot reset upstream peak while streams remain open');
    this.maximum = 0;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const requestId = request.headers['x-sulla-load-id'];
    if (typeof requestId === 'string') {
      this.requestAtNs.set(requestId, process.hrtime.bigint().toString());
      if (this.requestAtNs.size > 10_000) {
        const oldest = this.requestAtNs.keys().next().value as string;
        this.requestAtNs.delete(oldest);
        this.tlsAtNs.delete(oldest);
      }
    }
    const secureAt = this.tlsReadyAtNs.get(request.socket as TLSSocket);
    if (secureAt && typeof requestId === 'string') this.tlsAtNs.set(requestId, secureAt.toString());

    const mode = request.headers['x-synthetic-load-mode'] === 'short' ? 'short' : 'stream';
    const rawHold = request.headers['x-synthetic-hold-seconds'];
    const holdSeconds = Math.min(300, Math.max(1, Number(rawHold) || 30));
    let requestBytes = 0;
    request.on('data', chunk => { requestBytes += Buffer.byteLength(chunk); });
    request.once('end', () => {
      this.totalBodyBytes += requestBytes;
      this.maxBodyBytes = Math.max(this.maxBodyBytes, requestBytes);
      if (mode === 'short') {
        this.shortRequests++;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end('{"ok":true}');
        return;
      }
      this.openStream(response, holdSeconds);
    });
    request.once('error', () => response.destroy());
  }

  private openStream(response: ServerResponse, holdSeconds: number): void {
    this.streamRequests++;
    this.active++;
    this.maximum = Math.max(this.maximum, this.active);
    response.statusCode = 200;
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.flushHeaders();
    response.write('data: synthetic\n\n');

    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(endTimer);
      this.active--;
    };
    const heartbeat = setInterval(() => response.write('data: synthetic\n\n'), 1_000);
    const endTimer = setTimeout(() => response.end(), holdSeconds * 1_000);
    heartbeat.unref?.();
    endTimer.unref?.();
    response.once('close', finish);
    response.once('finish', finish);
  }
}
