// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { composeReply, parseReply, replyExcerpt } from '@pkg/pages/chat/messages/replyQuote';

describe('reply to a message block', () => {
  // risk: the agent must receive exactly the chunk the user is answering
  it('sends the excerpt as a quote ahead of the user text, and reads it back', () => {
    const sent = composeReply('Remaining checks: I run the last 4.\nSmoke test: still going.', 'Do the smoke test first.');

    expect(sent).toBe('> Remaining checks: I run the last 4.\n> Smoke test: still going.\n\nDo the smoke test first.');
    expect(parseReply(sent)).toEqual({ quote: 'Remaining checks: I run the last 4.\nSmoke test: still going.', body: 'Do the smoke test first.' });
  });

  it('leaves ordinary messages alone', () => {
    expect(parseReply('Just a normal message')).toBeNull();
  });

  // risk: replying to a whole long report must not paste the entire report into the chat
  it('cuts long excerpts at a word boundary with an ellipsis', () => {
    const excerpt = replyExcerpt('word '.repeat(400), 100);

    expect(excerpt.length).toBeLessThanOrEqual(101);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).not.toMatch(/wor…$/);
  });

  it('drops blank lines and stray indentation from the excerpt', () => {
    expect(replyExcerpt('  First line\n\n   Second line  ')).toBe('First line\nSecond line');
  });
});
