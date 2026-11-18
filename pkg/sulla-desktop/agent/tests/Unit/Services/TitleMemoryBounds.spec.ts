// Sulla Desktop · https://sulladesktop.com
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { TitleMessageBuffer } from '../../../services/TitleMessageBuffer';
import { TitledConversationTracker } from '../../../services/ConversationTitleService';

describe('title memory bounds', () => {
  it('retains only the first five title-eligible messages and clears finished conversations', () => {
    // risk: per-conversation memory growth
    const buffer = new TitleMessageBuffer();
    for (let i = 0; i < 100; i++) buffer.append('thread', { role: 'user', content: `${i}` });
    const saved = buffer.append('thread', { role: 'user', content: 'extra' });
    expect(saved.map(message => message.content)).toEqual(['0', '1', '2', '3', '4']);
    buffer.delete('thread');
    expect(buffer.size).toBe(0);
  });

  it('bounds successful title tracking while allowing failed attempts to retry', () => {
    // risk: title metadata cache growth and permanently suppressed retry
    const tracker = new TitledConversationTracker(2);
    expect(tracker.begin('failed')).toBe(true);
    tracker.fail('failed');
    expect(tracker.begin('failed')).toBe(true);
    tracker.succeed('failed');
    tracker.succeed('second');
    tracker.succeed('third');
    expect(tracker.size).toBe(2);
    expect(tracker.has('failed')).toBe(false);
    expect(tracker.has('third')).toBe(true);
  });
});
