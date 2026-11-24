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
});
