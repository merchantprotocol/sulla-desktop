// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send }) }));

import { ChannelTagExtractor } from '../../../controllers/ChannelTagExtractor';
import { a2aMarkersToText, stripProtocolTagsForUi } from '../../../utils/stripProtocolTags';
import { A2aCardMarkup } from '../../../../pages/chat/messages/a2aCardMarkup';

describe('ChannelTagExtractor', () => {
  beforeEach(() => send.mockReset());

  it('converts persisted A2A markers into readable model text while retaining the original UI card marker', () => { // risk: model-history pollution / UI card loss
    const card = { id: 'm-1', to: 'coding-manager', targetId: 'abc', body: 'Review the patch' };
    const encoded = Buffer.from(JSON.stringify(card)).toString('base64url');
    const marker = `⟦SULLA_A2A:${encoded}⟧`;
    expect(a2aMarkersToText(`sent ${marker}`)).toBe('sent [a2a → coding-manager#abc: Review the patch]');
    expect(stripProtocolTagsForUi(marker)).toBe(marker);
    expect(new A2aCardMarkup().render(marker)).toContain('Review the patch');
    expect(marker).toContain('⟦SULLA_A2A:');
  });

  it('labels a peer envelope with the stable agent identity rather than its transport channel', () => { // risk: message provenance
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:reviewer>independent finding</channel:reviewer>' } as any;
    extractor.processComplete(response, {
      channel: 'sulla-desktop', threadId: 'child-thread', state: { metadata: { agentId: 'codex-sol-worker', wsChannel: 'sulla-desktop', delegatedJobId: 'job-1', delegatedTaskLabel: 'review task' } },
    } as any);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].data.envelope).toMatchObject({ from: 'codex-sol-worker', kind: 'peer', body: 'independent finding', senderChannel: 'sulla-desktop', senderThreadId: 'child-thread', senderJobId: 'job-1', senderLabel: 'review task' });
  });

  it('extracts a precise thread selector without lowercasing the id', () => { // risk: delivery to the wrong manager instance
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:coding-manager#Thread-AbC>update</channel:coding-manager#Thread-AbC>' } as any;
    extractor.processComplete(response, { channel: 'worker', threadId: 'sender', state: { metadata: { agentId: 'worker' } } } as any);
    expect(send.mock.calls[0][1].data.envelope.targetId).toBe('Thread-AbC');
    expect(send.mock.calls[0][1].data.receiverChannel).toBe('coding-manager');
  });

  it('targets replies to the exact peer thread from replyToThread metadata', () => { // risk: peer reply misdelivery
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:heartbeat>reply</channel:heartbeat>' } as any;
    extractor.processComplete(response, { channel: 'worker', threadId: 'worker-thread', state: { metadata: { agentId: 'worker', replyToThread: 'origin-thread' } } } as any);
    expect(send.mock.calls[0][1].data.envelope.replyToThreadId).toBe('origin-thread');
    expect(send.mock.calls[0][1].data.envelope.targetId).toBeUndefined();
  });

  it('deduplicates identical bodies independently per explicit target instance', () => {
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:manager#thread-a>same</channel:manager#thread-a><channel:manager#thread-b>same</channel:manager#thread-b>' } as any;
    extractor.processComplete(response, { channel: 'worker', threadId: 'sender', state: { metadata: { agentId: 'worker' } } } as any);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1].data.envelope.targetId).toBe('thread-a');
    expect(send.mock.calls[1][1].data.envelope.targetId).toBe('thread-b');
  });

  it('keeps a quoted unclosed channel example visible without dispatching it', () => { // risk: user-visible content loss / unintended peer message
    const extractor = new ChannelTagExtractor();
    const response = { content: 'Use "<channel:reviewer> as the routing syntax in documentation.' } as any;
    expect(extractor.processComplete(response, { channel: 'worker', threadId: 't', state: {} } as any))
      .toBe('Use "<channel:reviewer> as the routing syntax in documentation.');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not dispatch a complete channel example quoted as prose', () => { // risk: accidental peer delivery from quoted documentation
    const extractor = new ChannelTagExtractor();
    const quoted = 'Example: "<channel:reviewer>not a message</channel:reviewer>"';
    const response = { content: quoted } as any;
    expect(extractor.processComplete(response, { channel: 'worker', threadId: 't', state: {} } as any)).toBe(quoted);
    expect(send).not.toHaveBeenCalled();
  });

  it('shows channel syntax inside inline and fenced code without routing it', () => { // risk: quoting protocol syntax must not trigger a peer delivery
    const extractor = new ChannelTagExtractor();
    const text = '`<channel:agent>hello</channel:agent>`\n```xml\n<channel:agent>fenced</channel:agent>\n```';
    const response = { content: text } as any;
    expect(extractor.processComplete(response, { channel: 'worker', threadId: 't', state: {} } as any)).toBe(text);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps an unclosed channel block as plain text at end of reply', () => { // risk: partial protocol output hiding user text
    const extractor = new ChannelTagExtractor();
    const response = { content: 'Before <channel:agent>still visible at end' } as any;
    expect(extractor.processComplete(response, { channel: 'worker', threadId: 't', state: {} } as any))
      .toBe('Before <channel:agent>still visible at end');
    expect(send).not.toHaveBeenCalled();
  });

  it('replaces a closed channel tag with a durable visible card marker and dispatches once', () => { // risk: a2a visibility and accidental duplicate delivery
    const extractor = new ChannelTagExtractor();
    const response = { content: 'before <channel:reviewer#Thread-1>please check</channel:reviewer#Thread-1> after' } as any;
    const rendered = extractor.processComplete(response, { channel: 'worker', threadId: 't', state: {} } as any);
    expect(rendered).toMatch(/^before ⟦SULLA_A2A:/);
    expect(rendered).toContain('⟧ after');
    expect(rendered).not.toContain('<channel:');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('holds only a trailing partial opener and resumes with the rest of the reply', () => { // risk: live assistant reply truncated after a partial opener
    const extractor = new ChannelTagExtractor();
    const ctx = { channel: 'worker', threadId: 't', state: {} } as any;
    expect(extractor.processChunk('answer <channel:', ctx)).toBe('answer ');
    const rest = extractor.processChunk('agent>go</channel:agent> and more', ctx);
    expect(rest).toContain('and more');
    expect(rest).toMatch(/⟦SULLA_A2A:/);
    expect(rest).not.toBe('answer ');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('routes a spawned child channel message to its parent session thread, not another same-channel session', () => { // risk: cross-session message isolation
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:sulla-desktop>status for parent</channel:sulla-desktop>' } as any;
    extractor.processComplete(response, {
      channel: 'sulla-desktop', threadId: 'child-thread', state: { metadata: { isSubAgent: true, workflowParentChannel: 'sulla-desktop', parentConversationId: 'session-a', agentId: 'coding-manager-sol', wsChannel: 'sulla-desktop' } },
    } as any);

    expect(send.mock.calls[0][1].data).toMatchObject({ targetThreadId: 'session-a' });
    expect(send.mock.calls[0][1].data.envelope.replyToThreadId).toBe('session-a');
  });

  it('keeps ordinary peer channel routing unchanged for a spawned child', () => { // risk: peer routing compatibility
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:reviewer>peer finding</channel:reviewer>' } as any;
    extractor.processComplete(response, {
      channel: 'sulla-desktop', threadId: 'child-thread', state: { metadata: { isSubAgent: true, workflowParentChannel: 'sulla-desktop', parentConversationId: 'session-a', agentId: 'coding-manager-sol', wsChannel: 'sulla-desktop' } },
    } as any);

    expect(send.mock.calls[0][0]).toBe('reviewer');
    // Only a parent-channel reply is pinned to a thread; ordinary peers resolve by name, as on main.
    expect(send.mock.calls[0][1].data.targetThreadId).toBeUndefined(); // risk: delivery to a thread on the wrong channel
  });
});
