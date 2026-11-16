// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopRelayConversationOutbox, type DesktopRelayFrameTransport } from '../../../../main/cloud/relay/DesktopRelayConversationOutbox';
import type { DesktopRelayTimers, RelayFrame } from '../../../../main/cloud/relay/DesktopRelayPorts';

class RecordingTransport implements DesktopRelayFrameTransport {
  deviceId = 'desk-1';
  readonly frames: RelayFrame[] = [];
  readonly unchecked: RelayFrame[] = [];
  send(payload: RelayFrame): void { this.frames.push(payload) }
  sendUnchecked(payload: RelayFrame): void { this.unchecked.push(payload) }
  ofType(type: string): RelayFrame[] { return this.frames.filter(frame => frame.type === type) }
}

const timers: DesktopRelayTimers = {
  now:           () => Date.now(),
  setTimeout:    (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout:  timer => clearTimeout(timer),
  setInterval:   (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: timer => clearInterval(timer),
};

function createOutbox() {
  const transport = new RecordingTransport();
  const log = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { transport, log, outbox: new DesktopRelayConversationOutbox(transport, timers, log) };
}

describe('DesktopRelayConversationOutbox', () => {
  beforeEach(() => { vi.useFakeTimers() });
  afterEach(() => { vi.useRealTimers() });

  it('stamps frames with the oldest in-flight run and the desktop identity', () => {
    // risk: data accuracy — mobile matches frames to the run that produced them.
    const { outbox, transport } = createOutbox();
    outbox.registerRun('c1', 'run-a');
    outbox.registerRun('c1', 'run-b');
    outbox.registerRun('c1', 'run-a');
    outbox.sendChatFrame('c1', { type: 'chunk', delta: 'x' });

    expect(transport.frames).toEqual([{ type: 'chunk', delta: 'x', clientRunId: 'run-a', userMessageId: 'run-a', conversationId: 'c1', deviceId: 'desk-1' }]);
  });

  it('refuses conversation frames without a conversationId', () => {
    // risk: privacy — an unroutable frame must never be broadcast to the room.
    const { outbox, transport, log } = createOutbox();
    outbox.sendChatFrame(undefined, { type: 'done' });
    outbox.send({ type: 'message', content: 'x' });

    expect(transport.frames).toEqual([]);
    expect(log.error).toHaveBeenCalledWith('[DesktopRelay] BUG: refusing to send done frame without conversationId');
    expect(log.error).toHaveBeenCalledWith('[DesktopRelay] BUG: refusing to send message frame without conversationId');
  });

  it('delivers secure-channel conversations to their route, never the relay room', () => {
    // risk: privacy — dashboard conversations stay on the approved client's channel.
    const { outbox, transport } = createOutbox();
    const reply = vi.fn();
    outbox.setSecureRoute('c1', reply);
    outbox.sendChatFrame('c1', { type: 'ack', userMessageId: 'u1' });

    expect(reply).toHaveBeenCalledWith({ type: 'ack', userMessageId: 'u1', conversationId: 'c1', deviceId: 'desk-1' });
    expect(transport.frames).toEqual([]);

    outbox.clearSecureRoute('c1');
    outbox.sendChatFrame('c1', { type: 'ack', userMessageId: 'u1' });
    expect(transport.frames).toHaveLength(1);
  });

  it('keeps at most 500 secure routes, evicting the oldest', () => {
    // risk: resource exhaustion — routes are bounded.
    const { outbox, transport } = createOutbox();
    for (let i = 0; i <= 500; i++) outbox.setSecureRoute(`c${ i }`, vi.fn());
    outbox.sendChatFrame('c0', { type: 'keepalive' });
    outbox.sendChatFrame('c1', { type: 'keepalive' });
    expect(transport.frames.map(frame => frame.conversationId)).toEqual(['c0']);
  });

  it('a stale completion keeps the replacement run alive and retires only the old run id', async() => {
    // risk: data accuracy — a cancelled run finishing late must not end its replacement.
    const { outbox, transport } = createOutbox();
    outbox.registerRun('c1', 'old');
    outbox.registerRun('c1', 'new');
    outbox.beginRun('c1');

    outbox.completeRun('c1', { type: 'done', content: '' });
    expect(transport.ofType('done')).toEqual([{ type: 'done', content: '', clientRunId: 'old', userMessageId: 'old', conversationId: 'c1', deviceId: 'desk-1' }]);
    expect(outbox.activeConversationIds()).toEqual(['c1']);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(transport.ofType('keepalive').at(-1)).toMatchObject({ clientRunId: 'new' });

    outbox.completeRun('c1', { type: 'done', content: 'final' });
    expect(outbox.activeConversationIds()).toEqual([]);
    const sent = transport.frames.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.frames).toHaveLength(sent);
  });

  it('pauses keepalives while mobile is offline and resumes after a delivered frame', async() => {
    // risk: availability — no undeliverable spam while offline; liveness resumes on return.
    const { outbox, transport, log } = createOutbox();
    outbox.registerRun('c1', 'r1');
    outbox.beginRun('c1');
    outbox.peerOffline();
    outbox.peerOffline();
    expect(log.warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.ofType('keepalive')).toEqual([]);

    outbox.frameDelivered();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(transport.ofType('keepalive')).toHaveLength(1);
  });

  it('stops a keepalive after ten minutes if the run never completes', async() => {
    // risk: resource leak — a crashed agent must not keep pinging forever.
    const { outbox, transport } = createOutbox();
    outbox.registerRun('c1', 'r1');
    outbox.beginRun('c1');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const sent = transport.ofType('keepalive').length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.ofType('keepalive')).toHaveLength(sent);
  });

  it('cancelRun stops the keepalive and forgets the conversation', async() => {
    // risk: data accuracy — a cancelled run is no longer reported as running.
    const { outbox, transport } = createOutbox();
    outbox.beginRun('c1');
    outbox.cancelRun('c1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.ofType('keepalive')).toEqual([]);
    expect(outbox.activeConversationIds()).toEqual([]);
  });

  it('rejects malformed frames without the conversation guard', () => {
    // risk: data accuracy — the one unstamped error frame still reaches mobile.
    const { outbox, transport } = createOutbox();
    outbox.sendMissingConversationError('u1');
    expect(transport.unchecked).toEqual([{ type: 'error', reason: 'missing_conversation_id', userMessageId: 'u1' }]);
  });
});
