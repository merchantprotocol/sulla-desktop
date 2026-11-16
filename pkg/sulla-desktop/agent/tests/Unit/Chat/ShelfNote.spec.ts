// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { ShelfNotes } from '@pkg/pages/chat/messages/shelfNote';

const meta = { name: 'RC billing', status: 'shelved' as const, shelvedAt: '2026-11-14T22:00:00.000Z', chatThreadId: 't_abc', backendThreadId: 'thread_1', agentId: 'product-owner' };
const entry = (slug: string, shelvedAt: string, status: 'shelved' | 'resumed' = 'shelved') => ({ fileId: slug, slug, path: `Projects/Shelf/${ slug }.md`, goal: '', meta: { ...meta, name: slug, shelvedAt, status } });

describe('shelf commands', () => {
  it('reads shelve, shelve with a name, delete and resume', () => {
    expect(ShelfNotes.parseShelfCommand('/shelve')).toEqual({ kind: 'shelve' });
    expect(ShelfNotes.parseShelfCommand('/shelve  RC billing ')).toEqual({ kind: 'shelve', name: 'RC billing' });
    expect(ShelfNotes.parseShelfCommand('/shelve delete rc-billing')).toEqual({ kind: 'delete', name: 'rc-billing' });
    expect(ShelfNotes.parseShelfCommand('/resume rc-billing')).toEqual({ kind: 'resume', name: 'rc-billing' });
    expect(ShelfNotes.parseShelfCommand('/shelving is a word')).toBeNull();
  });

  // risk: a second shelve with the same name silently overwrote the first note
  it('never reuses an existing note name', () => {
    expect(ShelfNotes.uniqueSlug('RC Billing!', [])).toBe('rc-billing');
    expect(ShelfNotes.uniqueSlug('RC Billing', ['rc-billing', 'rc-billing-2'])).toBe('rc-billing-3');
  });
});

describe('the handoff note file', () => {
  it('round-trips its frontmatter, including names that need quoting', () => {
    const text = ShelfNotes.buildNote({ ...meta, tabTitle: 'main thread: billing #3' }, '## Goal\nFinish billing bugs #3 and #4.');
    const parsed = ShelfNotes.parseNote(text)!;
    expect(parsed.meta).toMatchObject({ ...meta, tabTitle: 'main thread: billing #3' });
    expect(ShelfNotes.goalLine(parsed.body)).toBe('Finish billing bugs #3 and #4.');
  });

  // risk: an agent rewrote status to "done" and the note vanished from the picker
  it('treats any status other than shelved as resumed', () => {
    const edited = ShelfNotes.buildNote(meta, 'x').replace('status: shelved', 'status: done');
    expect(ShelfNotes.parseNote(edited)!.meta.status).toBe('resumed');
  });

  it('rejects files that are not shelf notes', () => {
    expect(ShelfNotes.parseNote('# just a doc')).toBeNull();
    expect(ShelfNotes.parseNote('---\nname: x\n---\nbody')).toBeNull();
  });

  it('marks a note resumed without losing the body', () => {
    const resumed = ShelfNotes.parseNote(ShelfNotes.markResumed(ShelfNotes.buildNote(meta, '## Goal\nShip it.'), 't_new', new Date('2026-11-15T09:00:00Z')))!;
    expect(resumed.meta).toMatchObject({ status: 'resumed', resumedThreadId: 't_new', resumedAt: '2026-11-15T09:00:00.000Z' });
    expect(resumed.body).toBe('## Goal\nShip it.');
  });

  it('takes the note from between the handoff tags, or the whole reply', () => {
    expect(ShelfNotes.extractHandoff('Here you go.\n<handoff>\n## Goal\nX\n</handoff>\nDone.')).toBe('## Goal\nX');
    expect(ShelfNotes.extractHandoff('## Goal\nX')).toBe('## Goal\nX');
  });
});

describe('the resume picker', () => {
  it('lists newest first and hides resumed notes until asked', () => {
    const all = [entry('a', '2026-11-13T00:00:00Z'), entry('b', '2026-11-14T00:00:00Z'), entry('c', '2026-11-14T05:00:00Z', 'resumed')];
    expect(ShelfNotes.pickerEntries(all, false).map(e => e.slug)).toEqual(['b', 'a']);
    expect(ShelfNotes.pickerEntries(all, true).map(e => e.slug)).toEqual(['c', 'b', 'a']);
  });

  it('finds a note by slug or display name', () => {
    const all = [{ ...entry('rc-billing', '2026-11-14T00:00:00Z'), meta: { ...meta, name: 'RC billing' } }];
    expect(ShelfNotes.findEntry(all, 'RC Billing')?.slug).toBe('rc-billing');
    expect(ShelfNotes.findEntry(all, 'rc-billing')?.slug).toBe('rc-billing');
    expect(ShelfNotes.findEntry(all, 'nope')).toBeUndefined();
  });
});
