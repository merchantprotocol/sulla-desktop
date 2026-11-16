// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E10 (S4a): Discord gateway relay expiry, reconnect backoff and timer cleanup
// (a live timer would keep a provider credential reachable after the relay is gone).
// Coverage specs: all pass on main.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DefaultVaultRelayManager } from '../../../../../../services/sulla-vault/src/relays';

const SESSION_TTL_MS = 30 * 60_000;
const DISCORD_URL = 'wss://gateway.discord.gg';

/** Browser-style WebSocket double that can also report an upstream close. */
class RelayTestSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: RelayTestSocket[] = [];

  readyState = RelayTestSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly closes: Array<[number | undefined, string | undefined]> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) { RelayTestSocket.instances.push(this) }

  static last(): RelayTestSocket { return RelayTestSocket.instances[RelayTestSocket.instances.length - 1] }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }

  send(data: string): void { this.sent.push(data) }

  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
    this.readyState = RelayTestSocket.CLOSED;
  }

  open(): void {
    this.readyState = RelayTestSocket.OPEN;
    this.emit('open', {});
  }

  message(frame: unknown): void { this.emit('message', { data: JSON.stringify(frame) }) }

  /** The provider dropped the connection. */
  drop(code = 1006): void {
    this.readyState = RelayTestSocket.CLOSED;
    this.emit('close', { code });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class DiscordRelayFixture {
  readonly manager = new DefaultVaultRelayManager();
  readonly authority = new AbortController();
  fetches = 0;

  async open(): Promise<RelayTestSocket> {
    vi.stubGlobal('fetch', async() => {
      this.fetches += 1;
      return new Response(JSON.stringify({ url: DISCORD_URL }), { status: 200 });
    });
    await this.manager.open({ relayId: 'discord-e10', operation: 'discord.gateway', credential: 'discord-e10-credential', abortSignal: this.authority.signal });
    const socket = RelayTestSocket.last();
    socket.open();
    return socket;
  }

  consume(): { events: unknown[]; done: Promise<void> } {
    const events: unknown[] = [];
    const controller = new AbortController();
    const done = (async() => { for await (const event of this.manager.events('discord-e10', controller.signal)) events.push(event) })();
    return { events, done };
  }
}

beforeEach(() => {
  RelayTestSocket.instances = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('WebSocket', RelayTestSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Relay session expiry and cancellation', () => {
  it('closes itself at the 30-minute TTL: socket closed, event stream ended, relay gone', async() => { // risk: provider session outlives its grant
    const fx = new DiscordRelayFixture();
    const socket = await fx.open();
    const consumer = fx.consume();
    socket.message({ op: 0, s: 1, t: 'MESSAGE_CREATE', d: { content: 'hello' } });

    await vi.advanceTimersByTimeAsync(SESSION_TTL_MS - 1);
    expect(socket.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closes).toEqual([[1000, 'relay_closed']]);
    await consumer.done;
    expect(consumer.events).toEqual([expect.objectContaining({ sequence: 1, type: 'discord.message_create' })]);
    await expect(fx.manager.send('discord-e10', { type: 'discord.presence', payload: {} })).rejects.toThrow('relay_not_found');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close() cancels the expiry timer', async() => { // risk: timers keep credential-bearing sessions alive
    const fx = new DiscordRelayFixture();
    const socket = await fx.open();
    expect(vi.getTimerCount()).toBe(1);
    fx.manager.close('discord-e10', 'done');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SESSION_TTL_MS);
    expect(socket.sent).toEqual([]);
  });

  it('a Vault lock (authority abort) closes the relay and cancels its timers', async() => { // risk: relay keeps running after the vault locks
    const fx = new DiscordRelayFixture();
    const socket = await fx.open();
    fx.authority.abort(new Error('vault_locked'));
    expect(socket.closes).toEqual([[1000, 'relay_closed']]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Relay reconnect backoff', () => {
  it('backs off 1 s then 2 s while reconnects fail to open, and resets after a successful open', async() => { // risk: reconnect storm against the provider
    const fx = new DiscordRelayFixture();
    const first = await fx.open();
    expect(fx.fetches).toBe(1);

    first.drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(fx.fetches).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(RelayTestSocket.instances).toHaveLength(2);

    RelayTestSocket.last().drop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(RelayTestSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(RelayTestSocket.instances).toHaveLength(3);

    RelayTestSocket.last().open();
    RelayTestSocket.last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fx.fetches).toBe(1);
    expect(RelayTestSocket.instances).toHaveLength(4);
  });

  it('never reconnects once closed, even with a reconnect pending', async() => { // risk: closed relay re-opens with a stale credential
    const fx = new DiscordRelayFixture();
    const socket = await fx.open();
    socket.drop();
    fx.manager.close('discord-e10', 'done');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fx.fetches).toBe(1);
    expect(RelayTestSocket.instances).toHaveLength(1);
  });
});
