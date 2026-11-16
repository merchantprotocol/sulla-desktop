// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { RelaySocketLike } from '@pkg/main/cloudRelayTransport';

import {
  RELAY_SOCKET_OPEN,
  type DesktopRelayFilesPorts, type DesktopRelayLog, type DesktopRelayTimers, type RelayIncomingFrame,
} from './DesktopRelayPorts';

// WebSocket.send() is synchronous and buffers bytes in memory. Pause the
// upstream Files reader once the socket queue crosses the high-water mark,
// and do not resume until it drains below the low-water mark. This keeps a
// multi-GB share from being materialized as queued base64 frames in memory.
const SHARE_BUFFER_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const SHARE_BUFFER_LOW_WATER_BYTES = 1 * 1024 * 1024;
const SHARE_BUFFER_POLL_MS = 10;

/** Which socket is current, so a share bound to a replaced socket stops. */
export interface DesktopRelayCurrentSocket {
  readonly socket: RelaySocketLike | null;
  readonly generation: number;
}

interface ShareRequest {
  requestId:  string;
  controller: AbortController;
  socket:     RelaySocketLike;
  generation: number;
}

/** Streams a Sulla Files share to mobile as start/chunk/end frames with backpressure. */
export class DesktopRelayShareServer {
  private readonly requests = new Map<string, ShareRequest>();

  constructor(
    private readonly current: DesktopRelayCurrentSocket,
    private readonly files: DesktopRelayFilesPorts,
    private readonly timers: DesktopRelayTimers,
    private readonly log: DesktopRelayLog,
  ) {}

  async serve(msg: RelayIncomingFrame, socket: RelaySocketLike | null, generation: number): Promise<void> {
    if (!msg.requestId || !msg.linkId) return;
    if (socket?.readyState !== RELAY_SOCKET_OPEN || this.current.socket !== socket || this.current.generation !== generation) return;
    const previous = this.requests.get(msg.requestId);
    previous?.controller.abort();
    const request: ShareRequest = { requestId: msg.requestId, controller: new AbortController(), socket, generation };
    this.requests.set(msg.requestId, request);
    try {
      const token = await this.files.serviceToken();
      if (!token) throw new Error('Sulla Files authentication is unavailable');
      if (!this.isActive(request)) return;
      // Files only listens on pinned TLS now; the old plain-HTTP URL failed every shared-file fetch.
      const url = new URL(`/v1/local/shares/${ encodeURIComponent(msg.linkId) }/content`, this.files.origin());
      if (msg.path) url.searchParams.set('path', msg.path);
      const headers = new Headers({ 'X-Sulla-Files-Token': token }); if (msg.range) headers.set('Range', msg.range);
      const response = await this.files.fetch(url, { headers, signal: request.controller.signal });
      if (![200, 206, 416].includes(response.status) || (response.status !== 416 && !response.body)) throw new Error((await response.text()).slice(0, 200) || `Sulla Files returned ${ response.status }`);
      if (!this.sendFrame(request, 'share_fetch_start', {
        status:        response.status,
        mime:          response.headers.get('content-type') || 'application/octet-stream',
        name:          decodeURIComponent(response.headers.get('x-sulla-filename') || 'shared-file'),
        contentLength: Number(response.headers.get('content-length') || 0),
        contentRange:  response.headers.get('content-range') || undefined,
        acceptRanges:  response.headers.get('accept-ranges') || 'bytes',
      })) return;
      if (!response.body) { this.sendFrame(request, 'share_fetch_end'); return }
      const reader = response.body.getReader();
      while (true) {
        // Wait before asking the producer for another chunk. Once the socket
        // queue is full this prevents ReadableStream pull() from advancing.
        if (!await this.waitForCapacity(request)) return;
        const { done, value } = await reader.read(); if (done) break;
        if (!this.sendFrame(request, 'share_fetch_chunk', { data: Buffer.from(value).toString('base64') })) return;
      }
      this.sendFrame(request, 'share_fetch_end');
    } catch (error) {
      if (!request.controller.signal.aborted) {
        this.sendFrame(request, 'share_fetch_error', { error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.requests.get(msg.requestId) === request) this.requests.delete(msg.requestId);
    }
  }

  /** Mobile cancelled a share it started on this exact connection. */
  cancel(msg: RelayIncomingFrame, socket: RelaySocketLike | undefined, generation: number): void {
    const requestId = msg.requestId;
    if (typeof requestId !== 'string') return;
    const request = this.requests.get(requestId);
    if (request && request.socket === socket && request.generation === generation && this.isActive(request)) {
      request.controller.abort();
      this.requests.delete(requestId);
    }
  }

  /** Abort shares bound to `socket` (and `generation`), or every share when omitted. */
  abort(socket?: RelaySocketLike, generation?: number): void {
    for (const [requestId, request] of this.requests) {
      if (socket && (request.socket !== socket || (generation !== undefined && request.generation !== generation))) continue;
      request.controller.abort();
      this.requests.delete(requestId);
    }
  }

  private isActive(request: ShareRequest): boolean {
    return !request.controller.signal.aborted &&
      this.requests.get(request.requestId) === request &&
      this.current.socket === request.socket &&
      this.current.generation === request.generation &&
      request.socket.readyState === RELAY_SOCKET_OPEN;
  }

  private sendFrame(request: ShareRequest, type: string, payload: Record<string, unknown> = {}): boolean {
    if (!this.isActive(request)) return false;
    try {
      request.socket.send(JSON.stringify({ type, requestId: request.requestId, ...payload }));
      return true;
    } catch (error) {
      this.log.warn('[DesktopRelay] Share send failed:', error);
      request.controller.abort();
      this.requests.delete(request.requestId);
      return false;
    }
  }

  private async waitForCapacity(request: ShareRequest): Promise<boolean> {
    if (!this.isActive(request)) return false;
    if (request.socket.bufferedAmount <= SHARE_BUFFER_HIGH_WATER_BYTES) return true;
    while (request.socket.bufferedAmount > SHARE_BUFFER_LOW_WATER_BYTES) {
      if (!this.isActive(request)) return false;
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.timers.clearTimeout(timer);
          request.controller.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = this.timers.setTimeout(finish, SHARE_BUFFER_POLL_MS);
        request.controller.signal.addEventListener('abort', finish, { once: true });
      });
    }
    return this.isActive(request);
  }
}
