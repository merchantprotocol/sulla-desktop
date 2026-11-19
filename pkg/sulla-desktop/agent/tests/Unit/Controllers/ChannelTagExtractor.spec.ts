// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send }) }));

import { ChannelTagExtractor } from '../../../controllers/ChannelTagExtractor';

describe('ChannelTagExtractor', () => {
  beforeEach(() => send.mockReset());

  it('labels a peer envelope with the stable agent identity rather than its transport channel', () => { // risk: message provenance
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:reviewer>independent finding</channel:reviewer>' } as any;
    extractor.processComplete(response, {
      channel: 'sulla-desktop', threadId: 'child-thread', state: { metadata: { agentId: 'codex-sol-worker', wsChannel: 'sulla-desktop', delegatedJobId: 'job-1', delegatedTaskLabel: 'review task' } },
    } as any);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1].data).toMatchObject({ senderId: 'codex-sol-worker', senderChannel: 'sulla-desktop' });
    expect(send.mock.calls[1][1].data.envelope).toMatchObject({ from: 'codex-sol-worker', kind: 'peer', body: 'independent finding', senderChannel: 'sulla-desktop', senderThreadId: 'child-thread', senderJobId: 'job-1', senderLabel: 'review task' });
  });

  it('extracts a precise thread selector without lowercasing the id', () => { // risk: delivery to the wrong manager instance
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:coding-manager#Thread-AbC>update</channel:coding-manager#Thread-AbC>' } as any;
    extractor.processComplete(response, { channel: 'worker', threadId: 'sender', state: { metadata: { agentId: 'worker' } } } as any);
    expect(send.mock.calls[1][1].data.targetId).toBe('Thread-AbC');
    expect(send.mock.calls[1][1].data.receiverChannel).toBe('coding-manager');
  });

  it('targets replies to the exact peer thread from replyToThread metadata', () => { // risk: peer reply misdelivery
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:heartbeat>reply</channel:heartbeat>' } as any;
    extractor.processComplete(response, { channel: 'worker', threadId: 'worker-thread', state: { metadata: { agentId: 'worker', replyToThread: 'origin-thread' } } } as any);
    expect(send.mock.calls[1][1].data.envelope.targetId).toBe('origin-thread');
  });

  it('deduplicates identical bodies independently per explicit target instance', () => {
    const extractor = new ChannelTagExtractor();
    const response = { content: '<channel:manager#thread-a>same</channel:manager#thread-a><channel:manager#thread-b>same</channel:manager#thread-b>' } as any;
    extractor.processComplete(response, { channel: 'worker', threadId: 'sender', state: { metadata: { agentId: 'worker' } } } as any);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[1][1].data.envelope.targetId).toBe('thread-a');
    expect(send.mock.calls[3][1].data.envelope.targetId).toBe('thread-b');
  });
});
