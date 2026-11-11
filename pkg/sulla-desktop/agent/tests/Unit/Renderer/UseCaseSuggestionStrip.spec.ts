// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import type { SuggestedUseCase } from '@pkg/shared/useCaseSuggestions';
import { UseCaseSuggestionStrip, type StripKey } from '@pkg/pages/chat/services/UseCaseSuggestionStrip';

const item = (type: string, slug: string) => ({ type, slug, title: slug, description: '', score: 0.8, reason: '' }) as SuggestedUseCase;
const ITEMS = [item('workflow', 'digest'), item('agent', 'inbox'), item('skill', 'summarise'), item('recipe', 'crm'), item('skill', 'email'), item('skill', 'extra')];
const DRAFT = 'summarise weekly leads and email';
const key = (k: string, extra: Partial<StripKey> = {}): StripKey => ({ key: k, meta: false, ctrl: false, shift: false, alt: false, caretAtEnd: true, ...extra });

function openStrip(): UseCaseSuggestionStrip {
  const strip = new UseCaseSuggestionStrip();
  strip.receive(ITEMS, 5);

  return strip;
}

describe('UseCaseSuggestionStrip', () => {
  it('shows at most the visible limit and never a function', () => {
    const strip = new UseCaseSuggestionStrip();
    strip.receive([item('function', 'f'), ...ITEMS], 5);
    expect(strip.items.map(i => i.slug)).toEqual(['digest', 'inbox', 'summarise', 'crm', 'email']);
    strip.receive(ITEMS, 3);
    expect(strip.items).toHaveLength(3);
  });

  it('lets Enter send when nothing is highlighted', () => {
    expect(openStrip().handleKey(key('Enter'), DRAFT, false)).toEqual({ kind: 'ignored' });
  });

  it('↓ highlights row 1 only when the caret is at the end, then ↑↓ move and Enter picks', () => {
    const strip = openStrip();
    expect(strip.handleKey(key('ArrowDown', { caretAtEnd: false }), DRAFT, false).kind).toBe('ignored');
    expect(strip.handleKey(key('ArrowDown'), DRAFT, false).kind).toBe('consumed');
    expect(strip.active).toBe(0);
    strip.handleKey(key('ArrowDown', { caretAtEnd: false }), DRAFT, false);
    strip.handleKey(key('ArrowDown'), DRAFT, false);
    strip.handleKey(key('ArrowUp'), DRAFT, false);
    expect(strip.active).toBe(1);

    const picked = strip.handleKey(key('Enter'), DRAFT, false);
    expect(picked).toEqual({ kind: 'pick', item: ITEMS[1] });
    expect(strip.items).toEqual([]);
  });

  it('↑ from the first row returns to typing; ↓ stops at the last row', () => {
    const strip = openStrip();
    strip.handleKey(key('ArrowDown'), DRAFT, false);
    strip.handleKey(key('ArrowUp'), DRAFT, false);
    expect(strip.active).toBe(-1);
    expect(strip.handleKey(key('ArrowUp'), DRAFT, false).kind).toBe('ignored');
    for (let i = 0; i < 9; i++) strip.handleKey(key('ArrowDown'), DRAFT, false);
    expect(strip.active).toBe(4);
  });

  it('⌘1–5 and Ctrl1–5 pick directly', () => {
    expect(openStrip().handleKey(key('3', { meta: true }), DRAFT, false)).toEqual({ kind: 'pick', item: ITEMS[2] });
    expect(openStrip().handleKey(key('1', { ctrl: true }), DRAFT, false)).toEqual({ kind: 'pick', item: ITEMS[0] });
    expect(openStrip().handleKey(key('6', { meta: true }), DRAFT, false).kind).toBe('ignored');
  });

  it('typing clears the highlight', () => {
    const strip = openStrip();
    strip.handleKey(key('ArrowDown'), DRAFT, false);
    strip.draftChanged(`${ DRAFT }s`);
    expect(strip.active).toBe(-1);
  });

  it('Esc clears the highlight, a second Esc hides until the topic words change', () => {
    const strip = openStrip();
    strip.handleKey(key('ArrowDown'), DRAFT, false);
    strip.handleKey(key('Escape'), DRAFT, false);
    expect(strip.active).toBe(-1);
    expect(strip.isOpen(DRAFT, false)).toBe(true);

    strip.handleKey(key('Escape'), DRAFT, false);
    expect(strip.isOpen(DRAFT, false)).toBe(false);

    // Same first four topic words (punctuation / short words) stays hidden.
    strip.draftChanged(`${ DRAFT } to me!`);
    expect(strip.isOpen(`${ DRAFT } to me!`, false)).toBe(false);

    strip.draftChanged('invoice overdue stripe reminders');
    expect(strip.isOpen('invoice overdue stripe reminders', false)).toBe(true);
  });

  it('stays out of the way while the slash or @ popover owns the keyboard, and leaves Tab alone', () => {
    const strip = openStrip();
    expect(strip.isOpen(DRAFT, true)).toBe(false);
    expect(strip.handleKey(key('ArrowDown'), DRAFT, true).kind).toBe('ignored');
    expect(strip.handleKey(key('Escape'), DRAFT, true).kind).toBe('ignored');
    expect(strip.handleKey(key('Tab'), DRAFT, false).kind).toBe('ignored');
    expect(strip.handleKey(key('Enter', { shift: true }), DRAFT, false).kind).toBe('ignored');
  });

  it('keeps old results until new ones land and drops a stale highlight', () => {
    const strip = openStrip();
    for (let i = 0; i < 4; i++) strip.handleKey(key('ArrowDown'), DRAFT, false);
    expect(strip.active).toBe(3);
    strip.receive(ITEMS.slice(0, 2), 5);
    expect(strip.active).toBe(-1);
    expect(strip.items).toHaveLength(2);
  });
});
