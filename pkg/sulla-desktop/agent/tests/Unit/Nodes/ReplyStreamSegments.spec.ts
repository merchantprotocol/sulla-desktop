// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// The live reply must show each narration paragraph in full, in its own
// segment, while a Claude Code turn runs tools between them.
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMessageDispatcher } from '../../../database/models/MessageDispatcher';
import { BaseNode } from '../../../nodes/BaseNode';

import type { BaseThreadState, NodeResult } from '../../../nodes/Graph';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

class StreamProbeNode extends BaseNode {
  constructor() { super('stream-probe', 'Stream probe') }
  execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> { return Promise.resolve({ state, decision: { type: 'end' } } as any) }
}

interface Callbacks {
  onToken:    (token: string) => void;
  onActivity: (message: string, kind?: 'tool' | 'status') => void;
}

/**
 * Runs a provider script through the real stream emitter and the chat's real
 * message dispatcher; returns the reply bubbles the chat ends up showing.
 */
async function streamSegments(script: (callbacks: Callbacks) => Promise<void>): Promise<string[]> {
  const node = new StreamProbeNode();
  const sends: { content: string; kind: string; extras?: Record<string, unknown> }[] = [];
  vi.spyOn(node as any, 'wsChatMessage').mockImplementation((_state: unknown, content: unknown, _role: unknown, kind: unknown, extras: unknown) => {
    sends.push({ content: String(content), kind: String(kind), extras: extras as Record<string, unknown> | undefined });

    return Promise.resolve();
  });
  const state = { metadata: { threadId: 't', agentId: 'probe', options: {} }, messages: [] } as any;
  const provider = {
    getModel:   () => 'test',
    chatStream: async(_messages: unknown, callbacks: Callbacks) => {
      await script(callbacks);
      return { content: '', metadata: {} };
    },
  };
  await (node as any).callLLMStreaming(state, [{ role: 'user', content: 'go' }], {}, {}, provider);

  const ctx = { messages: [] as any[], graphRunning: { value: true }, registry: { setLoading() {} } };
  const dispatcher = createMessageDispatcher();
  for (const send of sends) {
    dispatcher.dispatch(ctx as any, 'probe', 't', {
      type: 'assistant_message',
      data: { ...send.extras, content: send.content, role: 'assistant', kind: send.kind, thread_id: 't' },
    } as any);
  }
  const segments = ctx.messages.filter(message => message.kind === 'streaming').map(message => String(message.content).trim());

  return segments;
}

afterEach(() => { vi.restoreAllMocks() });

describe('live reply segments around provider tool activity', () => {
  // risk: data accuracy — repeated tool activity must not fold the next narration paragraph into the prior one.
  it('keeps each narration paragraph separate when back-to-back tools report the same activity line', async() => {
    const segments = await streamSegments(({ onToken, onActivity }) => {
      onToken('Finding the address the app uses for Files:');
      onActivity('Running a shell command', 'tool');
      onToken('\n\n');
      onToken('The cause isn\'t in the code I can see.');
      onActivity('Running a shell command', 'tool');
      onToken('\n\n');
      onToken('The thread transcript isn\'t reachable from here.');

      return Promise.resolve();
    });

    expect(segments).toEqual([
      'Finding the address the app uses for Files:',
      'The cause isn\'t in the code I can see.',
      'The thread transcript isn\'t reachable from here.',
    ]);
  });

  // 69/109 raw characters are visible; ignoring padding would count only 19/39.
  const tableHeader = '| Keys                       | Val                        |\n|---|---|';
  const fullTable = tableHeader + '\n| left-hand         | rightway        |';

  // risk: the full reply that follows the live stream carried text the last
  // throttled update hadn't shown yet, and the chat silently dropped it
  it.each([
    { name: 'after a padded Markdown table header', streams: [['r', tableHeader]], final: fullTable, shown: [fullTable] },
    { name: 'with a corrected word boundary', streams: [['r', 'The customer is notable.']], final: 'The customer is not able.', shown: ['The customer is notable.', 'The customer is not able.'] },
  ])('keeps the end of the full reply that the live segments had not shown yet, $name', ({ streams, final, shown }) => {
    const ctx = { messages: [] as any[], graphRunning: { value: true }, registry: { setLoading() {} } };
    const dispatcher = createMessageDispatcher();
    const send = (content: string, kind: string, extras: Record<string, unknown> = {}) => dispatcher.dispatch(ctx as any, 'probe', 't', {
      type: 'assistant_message',
      data: { ...extras, content, role: 'assistant', kind, thread_id: 't' },
    } as any);
    streams.forEach(([replyStreamId, text], replySegment) => {
      if (replySegment > 0) send('Running a shell command', 'thinking', { reportingActivity: 'tool' });
      send(text!, 'streaming', replyStreamId ? { replyStreamId, replySegment } : {});
      send('', 'streaming_complete', replyStreamId ? { replyStreamId } : {});
    });
    const lastStreamId = ctx.messages.at(-1).id;
    send(final, 'progress');

    const replies = ctx.messages.filter(message => message.kind !== 'thinking');
    expect(replies.map(message => message.content)).toEqual(shown);
    if (shown.length === 1) expect(replies[0].id).toBe(lastStreamId);
  });
});
