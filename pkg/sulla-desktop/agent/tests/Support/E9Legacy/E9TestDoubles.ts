// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Test doubles for the E9 localAuthority equivalence specs; delete in final cleanup.
// This module must not import node:crypto, node:dns or node:https: the specs' vi.mock
// factories import it while those modules are being mocked.

import { EventEmitter } from 'node:events';

type RealRandomBytes = (size: number, callback?: (error: Error | null, buffer: Buffer) => void) => Buffer | void;

/** Deterministic randomBytes/randomUUID for code under test; real values when disabled. */
export class E9NodeDeterminism {
  enabled = false;
  private bytesDrawn = 0;
  private uuidsDrawn = 0;

  static shared(): E9NodeDeterminism {
    const holder = globalThis as { __e9NodeDeterminism?: E9NodeDeterminism };
    holder.__e9NodeDeterminism ??= new E9NodeDeterminism();
    return holder.__e9NodeDeterminism;
  }

  /** Builds the mocked node:crypto module from the real one. */
  static cryptoModule<T extends Record<string, unknown>>(actual: T): T {
    const shared = E9NodeDeterminism.shared();
    const realBytes = actual.randomBytes as RealRandomBytes;
    const realUuid = actual.randomUUID as () => string;
    const randomBytes = (size: number, callback?: (error: Error | null, buffer: Buffer) => void) =>
      shared.randomBytes(realBytes, size, callback);
    const randomUUID = () => shared.randomUUID(realUuid);
    const base = (actual.default ?? actual) as Record<string, unknown>;
    return { ...actual, randomBytes, randomUUID, default: { ...base, randomBytes, randomUUID } } as T;
  }

  reset(): void {
    this.bytesDrawn = 0;
    this.uuidsDrawn = 0;
  }

  randomBytes(real: RealRandomBytes, size: number, callback?: (error: Error | null, buffer: Buffer) => void): Buffer | void {
    if (!this.enabled || typeof callback === 'function') return real(size, callback);
    this.bytesDrawn += 1;
    const output = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) output[index] = (this.bytesDrawn * 37 + index * 11 + 5) & 0xff;
    return output;
  }

  randomUUID(real: () => string): string {
    if (!this.enabled) return real();
    this.uuidsDrawn += 1;
    return `e9000000-0000-4000-8000-${ this.uuidsDrawn.toString(16).padStart(12, '0') }`;
  }
}

/** Deterministic RandomSource for LocalVaultCrypto.compose (salts, item keys, nonces). */
export class E9CounterRandom {
  private drawn = 0;

  bytes(length: number): Uint8Array {
    this.drawn += 1;
    const output = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) output[index] = (this.drawn * 53 + index * 3 + 17) & 0xff;
    return output;
  }
}

/** A fixed clock for Date.now while a scenario runs. */
export class E9Clock {
  static readonly START = Date.UTC(2026, 10, 16, 12, 0, 0);
  now = E9Clock.START;

  reset(): void { this.now = E9Clock.START }
  advance(ms: number): void { this.now += ms }
}

export interface E9UpstreamRecord {
  method:   string;
  hostname: string;
  port:     number;
  path:     string;
  headers:  Record<string, string>;
  body:     string;
}

export interface E9UpstreamReply {
  status:   number;
  headers?: Record<string, string>;
  body?:    string | Buffer;
}

class E9FakeIncomingMessage extends EventEmitter {
  destroyed = false;

  constructor(readonly statusCode: number, readonly headers: Record<string, string>) {
    super();
  }

  resume(): this { return this }
  pause(): this { return this }
  destroy(): this { this.destroyed = true; return this }
}

class E9FakeClientRequest extends EventEmitter {
  reusedSocket = false;
  destroyed = false;
  private readonly chunks: Buffer[] = [];

  constructor(
    private readonly upstream: E9FakeUpstream,
    private readonly options: { method?: string; hostname?: string; port?: number; path?: string; headers?: Record<string, string> },
    private readonly callback: (response: E9FakeIncomingMessage) => void,
  ) {
    super();
  }

  write(chunk: Buffer | string): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }

  end(): this {
    setImmediate(() => this.respond());
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error) setImmediate(() => this.emit('error', error));
    return this;
  }

  private respond(): void {
    if (this.destroyed) return;
    const record: E9UpstreamRecord = {
      method:   String(this.options.method ?? 'GET'),
      hostname: String(this.options.hostname ?? ''),
      port:     Number(this.options.port ?? 443),
      path:     String(this.options.path ?? '/'),
      headers:  { ...(this.options.headers ?? {}) },
      body:     Buffer.concat(this.chunks).toString('utf8'),
    };
    this.upstream.requests.push(record);
    const reply = this.upstream.replyFor(record);
    const body = reply.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body);
    const response = new E9FakeIncomingMessage(reply.status, { ...(reply.headers ?? {}) });
    this.callback(response);
    setImmediate(() => {
      if (response.destroyed || this.destroyed) return;
      if (body.length) response.emit('data', body);
      setImmediate(() => {
        if (!response.destroyed && !this.destroyed) response.emit('end');
      });
    });
  }
}

/** Offline stand-in for node:https.request and node:dns.promises.lookup. */
export class E9FakeUpstream {
  readonly requests: E9UpstreamRecord[] = [];
  readonly lookups: string[] = [];
  private readonly replies = new Map<string, E9UpstreamReply>();
  private readonly addresses = new Map<string, Array<{ address: string; family: number }>>();

  static shared(): E9FakeUpstream {
    const holder = globalThis as { __e9FakeUpstream?: E9FakeUpstream };
    holder.__e9FakeUpstream ??= new E9FakeUpstream();
    return holder.__e9FakeUpstream;
  }

  static httpsModule<T extends Record<string, unknown>>(actual: T): T {
    const shared = E9FakeUpstream.shared();
    const request = (options: ConstructorParameters<typeof E9FakeClientRequest>[1], callback: (response: E9FakeIncomingMessage) => void) =>
      new E9FakeClientRequest(shared, options, callback);
    const base = (actual.default ?? actual) as Record<string, unknown>;
    return { ...actual, request, default: { ...base, request } } as T;
  }

  static dnsModule<T extends Record<string, unknown>>(actual: T): T {
    const shared = E9FakeUpstream.shared();
    const base = (actual.default ?? actual) as Record<string, unknown>;
    const promises = { ...(actual.promises as Record<string, unknown>), lookup: (hostname: string) => shared.lookup(hostname) };
    return { ...actual, promises, default: { ...base, promises } } as T;
  }

  reset(): void {
    this.requests.length = 0;
    this.lookups.length = 0;
    this.replies.clear();
    this.addresses.clear();
  }

  /** Replies for `${METHOD} ${hostname}${path}`; unknown requests get a 404 JSON body. */
  reply(key: string, reply: E9UpstreamReply): void { this.replies.set(key, reply) }

  resolve(hostname: string, addresses: Array<{ address: string; family: number }>): void { this.addresses.set(hostname, addresses) }

  replyFor(record: E9UpstreamRecord): E9UpstreamReply {
    return this.replies.get(`${ record.method } ${ record.hostname }${ record.path }`) ??
      { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"not_found"}' };
  }

  async lookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
    this.lookups.push(hostname);
    return this.addresses.get(hostname) ?? [{ address: '93.184.216.34', family: 4 }];
  }
}
