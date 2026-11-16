// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptJump } from '@pkg/pages/chat/messages/transcriptJump';

const entries = [
  { id: 'q1', kind: 'tool_question' },
  { id: 'g1', kind: 'thinking-group', messages: [{ id: 't1' }, { id: 't2' }] },
  { id: 'r1', kind: 'proactive' },
] as any[];

function line(id: string): HTMLElement {
  const el = document.createElement('div');
  el.dataset.id = id;
  el.scrollIntoView = vi.fn();
  el.animate = vi.fn() as any;
  document.body.append(el);
  return el;
}

describe('Jump to from the side dock and status line', () => {
  let jump: TranscriptJump;
  let els: Record<string, HTMLElement>;
  beforeEach(() => {
    document.body.innerHTML = '';
    jump = new TranscriptJump();
    els = { q1: line('q1'), g1: line('g1'), r1: line('r1') };
    for (const [id, el] of Object.entries(els)) jump.register(id, el);
  });

  // risk: "Jump to" on a decision or result did nothing because no transcript handled the event
  it('scrolls the decision or result card into view and marks it', () => {
    expect(jump.jump(entries, 'r1', false)).toBe(true);
    expect(els.r1.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(els.r1.animate).toHaveBeenCalled();
    expect(els.q1.scrollIntoView).not.toHaveBeenCalled();
  });

  it('a message folded into a work block jumps to that block', () => {
    expect(jump.jump(entries, 't2', false)).toBe(true);
    expect(els.g1.scrollIntoView).toHaveBeenCalled();
  });

  it('a component ref resolves to its root element, and an unknown message is not this chat\'s', () => {
    const root = line('x');
    jump.register('q1', { $el: root });
    jump.jump(entries, 'q1', false);
    expect(root.scrollIntoView).toHaveBeenCalled();
    expect(jump.jump(entries, 'other-chat-message', false)).toBe(false);
  });

  it('reduced motion: jumps without smooth scrolling or the flash', () => {
    jump.jump(entries, 'r1', true);
    expect(els.r1.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(els.r1.animate).not.toHaveBeenCalled();
  });
});
