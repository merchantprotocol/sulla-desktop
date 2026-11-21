// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { DesktopRelayAgentBridge } from '../../../../main/cloud/relay/DesktopRelayAgentBridge';
import { DesktopRelayConversationOutbox } from '../../../../main/cloud/relay/DesktopRelayConversationOutbox';
import type { DesktopRelayHistoryPorts, DesktopRelayTimers, RelayFrame } from '../../../../main/cloud/relay/DesktopRelayPorts';
import { DesktopRelayTurnScribe } from '../../../../main/cloud/relay/DesktopRelayTurnScribe';

type AgentMessage = { type: string; data?: unknown };

class BridgeHarness {
  readonly frames: RelayFrame[] = [];
  readonly scribed: { conversationId: string; role: string; content: string; id?: string }[] = [];
  handler: ((message: AgentMessage) => unknown) | null = null;
  readonly channel = {
    connect:   vi.fn(),
    send:      vi.fn(),
    onMessage: vi.fn((_channel: string, handler: (message: AgentMessage) => unknown) => { this.handler = handler }),
  };

  readonly history: DesktopRelayHistoryPorts = {
    scribe:          vi.fn(async(turn) => { this.scribed.push(turn) }),
    acceptUserTurn:  vi.fn().mockResolvedValue('accepted'),
    deriveMessageId: (conversationId, role, content) => `id:${ role }:${ content }`,
  };

  readonly log = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  readonly timers = { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn() } as unknown as DesktopRelayTimers;
  readonly outbox = new DesktopRelayConversationOutbox({ deviceId: 'desk-1', send: frame => this.frames.push(frame), sendUnchecked: vi.fn() }, this.timers, this.log);
  readonly cards = { registerMobileCard: vi.fn().mockResolvedValue(undefined) };
  readonly bridge = new DesktopRelayAgentBridge(() => this.channel, this.outbox, new DesktopRelayTurnScribe(this.history, this.log), this.cards, async() => 'desk-1', this.log);

  emit(type: string, data: Record<string, unknown>): Promise<void> {
    return this.handler!({ type, data }) as Promise<void>;
  }

  assistant(kind: string, content: string, threadId = 'c1'): Promise<void> {
    return this.emit('assistant_message', { kind, content, thread_id: threadId });
  }

  done(threadId = 'c1'): Promise<void> {
    return this.emit('relay_dispatch_complete', { relayRunId: 'r1', outcome: 'accepted', thread_id: threadId });
  }

  framesOf(type: string): RelayFrame[] { return this.frames.filter(frame => frame.type === type) }
}

function bridged(): BridgeHarness {
  const h = new BridgeHarness();
  h.outbox.registerRun('c1', 'r1');
  h.outbox.beginRun('c1');
  h.bridge.ensureBridged();
  h.bridge.ensureBridged();
  expect(h.channel.onMessage).toHaveBeenCalledOnce();
  expect(h.channel.connect).toHaveBeenCalledWith('mobile-relay');
  return h;
}

describe('DesktopRelayAgentBridge', () => {
  it('records only a recognized host outcome for scoped runs; missing completion evidence stays unknown', async() => {
    // risk: a reconnect presents an unknown execution as successfully completed.
    const h = new BridgeHarness();
    const thread = 'remote_fixture_1234';
    h.outbox.registerRun(thread, 'r1');
    h.outbox.beginRun(thread);
    h.bridge.ensureBridged();
    await h.done(thread);
    expect(h.framesOf('done')[0]).toMatchObject({ outcome: 'unknown', clientRunId: 'r1' });
    expect(h.scribed).toEqual([]);

    h.outbox.registerRun(thread, 'r2');
    h.outbox.beginRun(thread);
    await h.emit('transfer_data', { content: 'graph_execution_complete', stopReason: 'error', thread_id: thread });
    await h.emit('relay_dispatch_complete', { relayRunId: 'r2', outcome: 'accepted', thread_id: thread });
    expect(JSON.parse(h.scribed[0].content)).toEqual({ sullaCard: { version: 1, kind: 'run_outcome', runId: 'r2', outcome: 'failed' } });
    expect(h.framesOf('done')[1]).toMatchObject({ outcome: 'failed', clientRunId: 'r2' });
  });

  it('commits each streamed segment at its boundary and reuses the last id for done', async() => {
    // risk: data loss — multi-segment runs used to reach mobile with only their last segment.
    const h = bridged();
    await h.assistant('streaming', 'First part');
    await h.assistant('streaming_complete', '');
    await h.assistant('streaming', 'Second part');
    await h.done();

    expect(h.framesOf('message').map(frame => frame.content)).toEqual(['First part', 'Second part']);
    expect(h.framesOf('done')).toEqual([expect.objectContaining({ type: 'done', content: 'Second part', id: 'id:assistant:Second part', conversationId: 'c1' })]);
    expect(h.scribed.filter(turn => turn.role === 'assistant').map(turn => turn.content)).toEqual(['First part', 'Second part']);
  });

  it('does not commit a progress message already committed at its streaming boundary', async() => {
    // risk: data accuracy — mobile must not show the same reply twice.
    const h = bridged();
    await h.assistant('streaming', 'Answer');
    await h.assistant('streaming_complete', '');
    await h.assistant('progress', 'Answer ');
    await h.done();

    expect(h.framesOf('message')).toHaveLength(1);
    expect(h.scribed.filter(turn => turn.role === 'assistant')).toHaveLength(1);
    expect(h.framesOf('done')[0]).toMatchObject({ content: 'Answer', id: 'id:assistant:Answer' });
  });

  it('scribes a streaming-only reply once at done', async() => {
    // risk: data loss — a run with no progress message still lands in history.
    const h = bridged();
    await h.assistant('streaming', 'Only');
    await h.assistant('streaming', 'Only streamed');
    await h.done();

    expect(h.framesOf('chunk').map(frame => frame.delta)).toEqual(['Only', 'Only streamed']);
    expect(h.scribed.filter(turn => turn.role === 'assistant')).toEqual([expect.objectContaining({ role: 'assistant', content: 'Only streamed', id: 'id:assistant:Only streamed' })]);
    expect(h.framesOf('done')[0]).toMatchObject({ content: 'Only streamed', id: 'id:assistant:Only streamed' });
  });

  it('de-duplicates consecutive activity and scribes it as a tool turn', async() => {
    // risk: data accuracy — history shows what the agent did, once.
    const h = bridged();
    await h.assistant('thinking', 'Reading files');
    await h.assistant('thinking', 'Reading files');

    expect(h.framesOf('activity')).toEqual([{ type: 'activity', message: 'Reading files', conversationId: 'c1', deviceId: 'desk-1', clientRunId: 'r1', userMessageId: 'r1' }]);
    expect(h.scribed).toEqual([expect.objectContaining({ role: 'tool', content: 'Reading files' })]);
  });

  it('sends rich cards as versioned envelopes without extra event metadata', async() => {
    // risk: privacy — only whitelisted card fields are persisted and relayed.
    const h = bridged();
    await h.emit('assistant_message', { kind: 'tool_question', thread_id: 'c1', content: 'Pick one', toolQuestion: { q: 1 }, secretToken: 'nope' });

    expect(h.cards.registerMobileCard).toHaveBeenCalledWith('c1', 'tool_question', expect.objectContaining({ kind: 'tool_question' }));
    const card = h.framesOf('card')[0];
    expect(JSON.parse(card.content as string)).toEqual({ sullaCard: { version: 1, kind: 'tool_question', deviceId: 'desk-1', content: 'Pick one', toolQuestion: { q: 1 } } });
    expect(card.content).not.toContain('nope');
  });

  it('processes one thread in order even when a scribe is slow', async() => {
    // risk: data accuracy — done must never overtake the segment before it.
    const h = bridged();
    let release!: () => void;
    vi.mocked(h.history.scribe).mockImplementationOnce(async(turn) => {
      await new Promise<void>(resolve => { release = resolve });
      h.scribed.push(turn);
    });
    const slow = h.assistant('progress', 'Slow commit');
    const done = h.done();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(release).toBeTypeOf('function');
    expect(h.framesOf('done')).toEqual([]);
    release();
    await Promise.all([slow, done]);

    expect(h.frames.map(frame => frame.type)).toEqual(['message', 'done']);
  });

  it('does not publish an unsaved assistant turn or a successful terminal event', async() => {
    // risk: live transcript must not advertise a commit that cannot be recovered.
    const h = bridged();
    vi.mocked(h.history.scribe).mockRejectedValueOnce(new Error('local commit failed'));
    await h.assistant('progress', 'not saved');
    await h.done();
    expect(h.frames.map(frame => frame.type)).toEqual(['error']);
    expect(h.frames[0]).toMatchObject({ reason: 'relay_history_unavailable', clientRunId: 'r1' });
  });

  it('drops assistant frames without a thread id', async() => {
    // risk: privacy — an unroutable reply must not be sent anywhere.
    const h = bridged();
    await h.emit('assistant_message', { kind: 'progress', content: 'orphan' });
    expect(h.frames).toEqual([]);
    expect(h.scribed).toEqual([]);
  });
});
