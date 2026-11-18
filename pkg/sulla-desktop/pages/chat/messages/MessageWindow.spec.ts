import { describe, expect, it } from 'vitest';
import { MessageWindow } from './MessageWindow';

describe('MessageWindow', () => {
  it('keeps at most the newest fifty user turns and their contiguous follow-ups', () => {
    // risk: renderer memory exhaustion on long-lived chats
    const messages = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }));
    const windowed = new MessageWindow().trim(messages);
    expect(windowed[0].content).toBe('20');
    expect(windowed.at(-1)?.content).toBe('79');
    expect(windowed.filter(message => message.role === 'user')).toHaveLength(50);
  });

  it('limits payload by UTF-16 units but never drops the newest streaming message', () => {
    // risk: oversized messages starving the renderer, or losing live output
    const messages = [
      { role: 'user', content: 'x'.repeat(1_100_000) },
      { role: 'assistant', content: 'y'.repeat(1_100_000) },
      { role: 'assistant', kind: 'streaming', content: 'live' },
    ];
    expect(new MessageWindow().trim(messages)).toEqual([messages[2]]);
  });

  it('returns an empty window for an empty transcript', () => {
    expect(new MessageWindow().trim([])).toEqual([]);
  });
});
