// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'node:events';

/** Records every socket call as plain data so legacy and new relay transcripts compare with toEqual. */
function describeData(data: unknown): unknown {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return `hex:${ data.toString('hex') }`;
  if (data instanceof ArrayBuffer) return `hex:${ Buffer.from(data).toString('hex') }`;
  if (ArrayBuffer.isView(data)) return `hex:${ Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('hex') }`;
  return data;
}

/**
 * Stand-in for the global (WHATWG) WebSocket the Slack and Discord relays use.
 * `close()` only records and flips readyState; it never dispatches 'close', so
 * no reconnect timers start during a scripted sequence.
 */
export class FakeBrowserSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeBrowserSocket[] = [];

  readyState = FakeBrowserSocket.CONNECTING;
  readonly log: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(readonly url: string) {
    FakeBrowserSocket.instances.push(this);
    this.log.push(['new', String(url)]);
  }

  static reset(): void {
    FakeBrowserSocket.instances = [];
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: unknown): void {
    this.log.push(['send', describeData(data)]);
  }

  close(code?: number, reason?: string): void {
    this.log.push(['close', code ?? null, reason ?? null]);
    this.readyState = FakeBrowserSocket.CLOSED;
  }

  emitOpen(): void {
    this.readyState = FakeBrowserSocket.OPEN;
    this.dispatch('open', {});
  }

  emitMessage(data: unknown): void {
    this.dispatch('message', { data });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** Stand-in for the `ws` package's WebSocket used by the enterprise and Sulla Cloud relays. */
export class FakeNodeSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeNodeSocket[] = [];

  readyState = FakeNodeSocket.CONNECTING;
  bufferedAmount = 0;
  readonly log: unknown[] = [];

  constructor(readonly url: unknown, options?: Record<string, any>) {
    super();
    FakeNodeSocket.instances.push(this);
    this.log.push(['new', String(url), {
      headers:          options?.headers ?? null,
      maxPayload:       options?.maxPayload ?? null,
      followRedirects:  options?.followRedirects ?? null,
      handshakeTimeout: options?.handshakeTimeout ?? null,
      agent:            options?.agent ? options.agent.constructor.name : null,
    }]);
  }

  static reset(): void {
    FakeNodeSocket.instances = [];
  }

  static last(): FakeNodeSocket {
    const socket = FakeNodeSocket.instances[FakeNodeSocket.instances.length - 1];
    if (!socket) throw new Error('no fake ws socket was created');
    return socket;
  }

  send(data: unknown, options?: { binary?: boolean }): void {
    this.log.push(['send', describeData(data), options?.binary ?? null]);
  }

  close(code?: number, reason?: string): void {
    this.log.push(['close', code ?? null, reason ?? null]);
    this.readyState = FakeNodeSocket.CLOSED;
  }

  terminate(): void {
    this.log.push(['terminate']);
    this.readyState = FakeNodeSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeNodeSocket.OPEN;
    this.emit('open');
  }
}
