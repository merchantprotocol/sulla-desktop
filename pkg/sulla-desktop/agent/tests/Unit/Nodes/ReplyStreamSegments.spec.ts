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
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runs a provider script through the real stream emitter and the chat's real
 * message dispatcher; returns the reply bubbles the chat ends up showing.
 */
async function streamSegments(script: (callbacks: Callbacks) => Promise<void>): Promise<{ segments: string[]; afterBurst: string[] }> {
  const node = new StreamProbeNode();
  const sends: { content: string; kind: string; extras?: Record<string, unknown> }[] = [];
  vi.spyOn(node as any, 'wsChatMessage').mockImplementation((_state: unknown, content: unknown, _role: unknown, kind: unknown, extras: unknown) => {
    sends.push({ content: String(content), kind: String(kind), extras: extras as Record<string, unknown> | undefined });

    return Promise.resolve();
  });
  const state = { metadata: { threadId: 't', agentId: 'probe', options: {} }, messages: [] } as any;
  let afterBurst: string[] = [];
  const provider = {
    getModel:   () => 'test',
    chatStream: async(_messages: unknown, callbacks: Callbacks) => {
      await script({
        ...callbacks,
        onActivity: (message, kind) => {
          afterBurst = sends.filter(send => send.kind === 'streaming').map(send => send.content);
          callbacks.onActivity(message, kind);
        },
      });

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

  return { segments, afterBurst };
}

afterEach(() => { vi.restoreAllMocks() });

describe('live reply segments around provider tool activity', () => {
  it('publishes the tail of a fast burst while the tool is still running', async() => {
    const { afterBurst } = await streamSegments(async({ onToken, onActivity }) => {
      for (const token of ['There', ' is', ' one', ' cause.']) onToken(token);
      await pause(120); // the model is now in a long tool call; no new token arrives
      onActivity('Running a shell command', 'tool');
    });

    expect(afterBurst.at(-1)).toBe('There is one cause.');
  });

  it('keeps a paragraph that opens with the same word as an earlier one', async() => {
    const { segments } = await streamSegments(async({ onToken, onActivity }) => {
      onToken('The cause is the throttle.');
      onActivity('Running a shell command', 'tool');
      onToken('\n\n');
      onToken('The');
      await pause(120);
      onToken(' thread is fine.');
    });

    expect(segments).toEqual(['The cause is the throttle.', 'The thread is fine.']);
  });

  // risk: a one-word paragraph vanished from the chat when the next paragraph,
  // after a tool call, opened with that same word
  it('keeps a paragraph whose whole text opens the next paragraph after a tool call', async() => {
    const { segments } = await streamSegments(async({ onToken, onActivity }) => {
      onToken('Same');
      onActivity('Running a shell command', 'tool');
      onToken('\n\n');
      onToken('Same');
      await pause(120);
      onToken(' word, distinct paragraph.');
    });

    expect(segments).toEqual(['Same', 'Same word, distinct paragraph.']);
  });

  it('keeps each narration paragraph separate when back-to-back tools report the same activity line', async() => {
    const { segments } = await streamSegments(({ onToken, onActivity }) => {
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

  // risk: the full reply that follows the live stream carried text the last
  // throttled update hadn't shown yet, and the chat silently dropped it
  it.each([
    { name: 'with a corrected word boundary', streams: [['r', 'The customer is notable.']], final: 'The customer is not able.', shown: ['The customer is notable.', 'The customer is not able.'] },
    {
      name: 'with authoritative Markdown indentation after a tool',
      streams: [['r', 'Run this:'], ['r', 'echo one\necho two']],
      final: 'Run this:\n\n    echo one\n    echo two',
      shown: ['Run this:', 'echo one\necho two', 'Run this:\n\n    echo one\n    echo two'],
    },
    { name: 'after several segments', streams: [['r', 'Checked files.'], ['r', 'Build']], final: 'Checked files.\n\nBuild passed.', shown: ['Checked files.', 'Build passed.'] },
    { name: 'keeping an indented code block', streams: [['r', 'Here is the example:'], ['r', '    echo']], final: 'Here is the example:\n\n    echo ok', shown: ['Here is the example:', '    echo ok'] },
    { name: 'after one segment with different spacing', streams: [['r', 'Build  passed']], final: 'Build passed today', shown: ['Build passed today'] },
    { name: 'without moving it into another reply stream', streams: [['a', 'Tests:'], ['b', 'PASS']], final: 'Tests: PASS (6/6)', shown: ['Tests:', 'PASS', 'Tests: PASS (6/6)'] },
    { name: 'without moving it into segments of unknown streams', streams: [[undefined, 'Tests:'], [undefined, 'PASS']], final: 'Tests: PASS (6/6)', shown: ['Tests:', 'PASS', 'Tests: PASS (6/6)'] },
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
    send(final, 'progress');

    expect(ctx.messages.filter(message => message.kind !== 'thinking').map(message => message.content)).toEqual(shown);
  });
});
