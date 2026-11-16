// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { RelayEventQueue } from './RelayEventQueue.js';
import { MAX_EVENT_BYTES, RECONNECT_MAX_MS, SESSION_TTL_MS } from './RelayLimits.js';

import type { BrokerRelaySendRequest } from '../contracts.js';
import type { RelaySession, VaultRelayEvent, VaultRelayOperation } from './RelayContracts.js';

export abstract class BaseRelaySession implements RelaySession {
  readonly expiresAt = Date.now() + SESSION_TTL_MS;
  protected readonly sensitiveValues = new Set<string>();
  protected readonly output: RelayEventQueue;
  protected socket:          WebSocket | null = null;
  protected closed = false;
  protected reconnectAttempt = 0;
  protected drainOnClose = false;
  protected reconnectTimer:  NodeJS.Timeout | null = null;
  protected expiryTimer:     NodeJS.Timeout;

  constructor(
    readonly relayId: string,
    readonly operation: VaultRelayOperation,
    protected credential: string,
    protected readonly authoritySignal: AbortSignal,
    maxEventBytes = MAX_EVENT_BYTES,
  ) {
    this.sensitiveValues.add(credential);
    this.output = new RelayEventQueue(() => this.sensitiveValues, maxEventBytes);
    this.expiryTimer = setTimeout(() => this.close('expired'), SESSION_TTL_MS);
    this.expiryTimer.unref?.();
    if (authoritySignal.aborted) {
      this.close('authority_aborted');
      throw new Error('authority_aborted');
    }
    authoritySignal.addEventListener('abort', () => this.close('authority_aborted'), { once: true });
  }

  events(signal: AbortSignal): AsyncIterable<VaultRelayEvent> {
    return this.output.iterate(signal);
  }

  abstract start(): Promise<void>;
  abstract send(command: BrokerRelaySendRequest): Promise<void>;

  close(_reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiryTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'relay_closed');
    this.socket = null;
    this.credential = '';
    this.output.end(this.drainOnClose);
    this.sensitiveValues.clear();
  }

  protected connect(url: string): WebSocket {
    if (this.closed) throw new Error('relay_closed');
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.onOpen(socket);
    });
    socket.addEventListener('message', event => {
      try {
        this.onMessage(socket, event.data);
      } catch {
        socket.close(1009, 'invalid_frame');
      }
    });
    socket.addEventListener('close', event => {
      if (this.socket === socket) this.socket = null;
      if (!this.closed) this.onDisconnect(event.code);
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) socket.close();
    });
    this.socket = socket;
    return socket;
  }

  protected abstract onOpen(socket: WebSocket): void;
  protected abstract onMessage(socket: WebSocket, data: unknown): void;
  protected abstract reconnect(): Promise<void>;

  protected onDisconnect(_code: number): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt++, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect().catch(() => this.onDisconnect(0));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  protected parse(data: unknown): Record<string, any> | null {
    const byteLength = typeof data === 'string'
      ? Buffer.byteLength(data)
      : data instanceof ArrayBuffer
        ? data.byteLength
        : ArrayBuffer.isView(data)
          ? data.byteLength
          : MAX_EVENT_BYTES + 1;
    if (byteLength > MAX_EVENT_BYTES) throw new Error('relay_frame_too_large');
    try {
      const text = typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
            : '';
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
}
