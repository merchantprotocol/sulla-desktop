// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RelaySocketLike } from '../../../../main/cloudRelayTransport';
import type { DesktopRelaySocketPorts, DesktopRelayTimers, VaultRelaySocketView } from '../../../../main/cloud/relay/DesktopRelayPorts';
import { DesktopRelayTransport, type DesktopRelayTransportEvents } from '../../../../main/cloud/relay/DesktopRelayTransport';

class FakeSocket implements RelaySocketLike {
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: any) => void)[]>();

  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true; this.readyState = 3 }
  emit(type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  open(): void { this.readyState = 1; this.emit('open') }
  drop(): void { this.readyState = 3; this.emit('close') }
}

class TransportHarness {
  readonly sockets: FakeSocket[] = [];
  readonly vaultViews = new Map<RelaySocketLike, VaultRelaySocketView>();
  readonly events = { message: vi.fn(), socketReleased: vi.fn(), sessionReset: vi.fn(), frameDelivered: vi.fn() } satisfies DesktopRelayTransportEvents;
  readonly session = {
    accessToken:     vi.fn().mockResolvedValue('token-1'),
    deviceId:        vi.fn().mockResolvedValue('desk-1'),
    acquireLiveness: vi.fn(),
    releaseLiveness: vi.fn(),
  };

  readonly log = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  readonly timers: DesktopRelayTimers = {
    now:           () => Date.now(),
    setTimeout:    (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout:  timer => clearTimeout(timer),
    setInterval:   (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: timer => clearInterval(timer),
  };

  readonly socketPorts: DesktopRelaySocketPorts = {
    usesVault:  () => false,
    openVault:  room => this.track(new FakeSocket(`vault:${ room }`)),
    openNative: url => this.track(new FakeSocket(url)),
    vaultView:  socket => this.vaultViews.get(socket) ?? null,
  };

  readonly transport = new DesktopRelayTransport(this.socketPorts, this.session, this.timers, this.log, this.events);

  latest(): FakeSocket { return this.sockets[this.sockets.length - 1] }
  private track(socket: FakeSocket): FakeSocket { this.sockets.push(socket); return socket }
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('DesktopRelayTransport', () => {
  beforeEach(() => { vi.useFakeTimers() });
  afterEach(() => { vi.useRealTimers() });

  it('doubles the reconnect delay on each failure and caps it at five minutes', async() => {
    // risk: availability — backoff must neither hammer the relay nor stop retrying.
    const h = new TransportHarness();
    h.transport.connect('room-1');
    await settle();
    const expected = [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300].map(s => s * 1_000);
    for (const delay of expected) {
      const before = h.sockets.length;
      h.latest().drop();
      await settle(delay - 1);
      expect(h.sockets).toHaveLength(before);
      await settle(1);
      expect(h.sockets).toHaveLength(before + 1);
    }
  });

  it('keeps retrying when opening the socket throws', async() => {
    // risk: availability — one failed session read used to kill the reconnect loop for good.
    const h = new TransportHarness();
    h.session.accessToken.mockRejectedValueOnce(new Error('postgres waking')).mockRejectedValueOnce(new Error('still waking'));
    h.transport.connect('room-1');
    await settle();
    expect(h.sockets).toHaveLength(0);
    await settle(1_000);
    expect(h.sockets).toHaveLength(0);
    await settle(2_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.log.warn).toHaveBeenCalledWith('[DesktopRelay] openSocket failed: postgres waking');
  });

  it('ignores the late close of a superseded socket', async() => {
    // risk: availability — a stale socket's close must not tear down the live connection.
    const h = new TransportHarness();
    h.transport.connect('room-1');
    await settle();
    const stale = h.latest();
    await settle(15_000 + 1_000);
    const live = h.latest();
    expect(live).not.toBe(stale);
    live.open();

    stale.emit('close');
    expect(h.events.socketReleased).toHaveBeenLastCalledWith(stale, 1);
    expect(h.transport.getStatus().connected).toBe(true);
    expect(h.transport.socket).toBe(live);
  });

  it('queues only durable frames while down and flushes them in order on open', async() => {
    // risk: data loss — completion frames survive a reconnect; streaming noise does not pile up.
    const h = new TransportHarness();
    h.transport.connect('room-1');
    await settle();
    h.transport.send({ type: 'done', conversationId: 'c1' }, 'done');
    h.transport.send({ type: 'chunk', conversationId: 'c1' }, 'chunk');
    h.transport.send({ type: 'ack', conversationId: 'c1' }, 'ack');
    h.latest().open();

    expect(h.latest().sent).toEqual(['{"type":"done","conversationId":"c1"}', '{"type":"ack","conversationId":"c1"}']);
    expect(h.events.frameDelivered).not.toHaveBeenCalled();
    h.transport.send({ type: 'chunk', conversationId: 'c1' }, 'chunk');
    expect(h.events.frameDelivered).toHaveBeenCalledOnce();
  });

  it('recovers durable frames stranded in a failed vault send queue', async() => {
    // risk: data loss — a vault socket failure must not drop queued done/message frames.
    const h = new TransportHarness();
    h.transport.connect('room-1');
    await settle();
    const first = h.latest();
    first.open();
    h.vaultViews.set(first, {
      failure:             'unavailable',
      failureDetail:       'HTTP 502',
      takePendingOutbound: () => ['{"type":"message","id":"m1"}', '{"type":"chunk"}', 'not json'],
    });
    first.drop();
    await settle(1_000);
    h.latest().open();

    expect(h.latest().sent).toEqual(['{"type":"message","id":"m1"}']);
    expect(h.log.warn).toHaveBeenCalledWith('[DesktopRelay] Sulla Cloud relay unavailable — retrying with backoff (HTTP 502)');
  });

  it('disconnect drops queued frames, resets the session and never reconnects', async() => {
    // risk: sign-out — an unpaired desktop must not keep a socket or replay old frames.
    const h = new TransportHarness();
    h.transport.connect('room-1');
    await settle();
    h.transport.send({ type: 'done', conversationId: 'c1' }, 'done');
    h.transport.disconnect();

    expect(h.events.sessionReset).toHaveBeenCalledOnce();
    expect(h.latest().closed).toBe(true);
    expect(h.transport.getStatus()).toEqual({ pairedUserId: '', connected: false, lastError: undefined });
    await settle(10 * 60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('forces a reconnect when an open socket goes silent', async() => {
    // risk: availability — a half-open socket (no FIN) must be detected by the watchdog.
    const h = new TransportHarness();
    h.transport.connect('room-1');
    await settle();
    h.latest().open();
    await settle(2 * 60_000);
    expect(h.sockets.length).toBeGreaterThan(1);
    expect(h.sockets[0].closed).toBe(true);
  });
});
