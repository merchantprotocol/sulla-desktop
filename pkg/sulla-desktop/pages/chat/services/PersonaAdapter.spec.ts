// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { PersonaAdapter } from './PersonaAdapter';

describe('PersonaAdapter send feedback reconciliation', () => {
  it('replaces matching optimistic bubbles in FIFO order before backend sync appends them', () => {
    // risk: data accuracy — sync order must not leave a duplicate user bubble.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    const transcript = [
      { id: 'optimistic-1', kind: 'user', text: 'same' },
      { id: 'optimistic-2', kind: 'user', text: 'same' },
    ];
    const backendMessages = [
      { id: 'backend-1', role: 'user', kind: 'text', content: '[voice] same' },
      { id: 'backend-2', role: 'user', kind: 'text', content: 'same' },
    ];
    adapter.ci = { messages: { value: backendMessages } };
    adapter.controller = {
      thread: { value: { messages: transcript } },
      updateMessage: (id: string, patch: object, index: number) => { transcript[index] = { ...transcript[index], ...patch }; },
      removeMessage: () => {},
    };
    adapter.optimisticUserMessages = new Map([['same', ['optimistic-1', 'optimistic-2']]]);
    adapter.seen = new Set();
    adapter.mapBackendMessage = (message: any) => ({ id: message.id, kind: 'user', text: message.content });

    adapter.reconcileOptimisticUserMessages();

    expect(transcript).toHaveLength(2);
    expect(transcript.map((message: any) => message.id)).toEqual(['backend-1', 'backend-2']);
    expect(adapter.seen).toEqual(new Set(['backend-1', 'backend-2']));
    expect(adapter.optimisticUserMessages.size).toBe(0);
  });

  it('does not mistake assistant history for this send’s first token', () => {
    // risk: telemetry accuracy — first-token latency must start after the send.
    const adapter = Object.create(PersonaAdapter.prototype) as any;
    const history = [{ id: 'old', role: 'assistant', kind: 'text', content: 'earlier answer' }];
    expect(adapter.hasNewAssistantText(history, history.length)).toBe(false);
    expect(adapter.hasNewAssistantText([...history, { id: 'new', role: 'assistant', kind: 'streaming', content: 'new token' }], history.length)).toBe(true);
  });
});
