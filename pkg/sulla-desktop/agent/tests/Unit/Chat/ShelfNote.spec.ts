// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import {
  buildNote, extractHandoff, findEntry, goalLine, markResumed, parseNote, parseShelfCommand, pickerEntries, uniqueSlug,
} from '@pkg/pages/chat/messages/shelfNote';

const meta = { name: 'RC billing', status: 'shelved' as const, shelvedAt: '2026-11-14T22:00:00.000Z', chatThreadId: 't_abc', backendThreadId: 'thread_1', agentId: 'product-owner' };
const entry = (slug: string, shelvedAt: string, status: 'shelved' | 'resumed' = 'shelved') => ({ fileId: slug, slug, path: `Projects/Shelf/${ slug }.md`, goal: '', meta: { ...meta, name: slug, shelvedAt, status } });

describe('shelf commands', () => {
  it('reads shelve, shelve with a name, delete and resume', () => {
    expect(parseShelfCommand('/shelve')).toEqual({ kind: 'shelve' });
    expect(parseShelfCommand('/shelve  RC billing ')).toEqual({ kind: 'shelve', name: 'RC billing' });
    expect(parseShelfCommand('/shelve delete rc-billing')).toEqual({ kind: 'delete', name: 'rc-billing' });
    expect(parseShelfCommand('/resume rc-billing')).toEqual({ kind: 'resume', name: 'rc-billing' });
    expect(parseShelfCommand('/shelving is a word')).toBeNull();
  });

  // risk: a second shelve with the same name silently overwrote the first note
  it('never reuses an existing note name', () => {
    expect(uniqueSlug('RC Billing!', [])).toBe('rc-billing');
    expect(uniqueSlug('RC Billing', ['rc-billing', 'rc-billing-2'])).toBe('rc-billing-3');
  });
});

describe('the handoff note file', () => {
  it('round-trips its frontmatter, including names that need quoting', () => {
    const text = buildNote({ ...meta, tabTitle: 'main thread: billing #3' }, '## Goal\nFinish billing bugs #3 and #4.');
    const parsed = parseNote(text)!;
    expect(parsed.meta).toMatchObject({ ...meta, tabTitle: 'main thread: billing #3' });
    expect(goalLine(parsed.body)).toBe('Finish billing bugs #3 and #4.');
  });

  // risk: an agent rewrote status to "done" and the note vanished from the picker
  it('treats any status other than shelved as resumed', () => {
    const edited = buildNote(meta, 'x').replace('status: shelved', 'status: done');
    expect(parseNote(edited)!.meta.status).toBe('resumed');
  });

  it('rejects files that are not shelf notes', () => {
    expect(parseNote('# just a doc')).toBeNull();
    expect(parseNote('---\nname: x\n---\nbody')).toBeNull();
  });

  it('marks a note resumed without losing the body', () => {
    const resumed = parseNote(markResumed(buildNote(meta, '## Goal\nShip it.'), 't_new', new Date('2026-11-15T09:00:00Z')))!;
    expect(resumed.meta).toMatchObject({ status: 'resumed', resumedThreadId: 't_new', resumedAt: '2026-11-15T09:00:00.000Z' });
    expect(resumed.body).toBe('## Goal\nShip it.');
  });

  it('takes the note from between the handoff tags, or the whole reply', () => {
    expect(extractHandoff('Here you go.\n<handoff>\n## Goal\nX\n</handoff>\nDone.')).toBe('## Goal\nX');
    expect(extractHandoff('## Goal\nX')).toBe('## Goal\nX');
  });
});

describe('the resume picker', () => {
  it('lists newest first and hides resumed notes until asked', () => {
    const all = [entry('a', '2026-11-13T00:00:00Z'), entry('b', '2026-11-14T00:00:00Z'), entry('c', '2026-11-14T05:00:00Z', 'resumed')];
    expect(pickerEntries(all, false).map(e => e.slug)).toEqual(['b', 'a']);
    expect(pickerEntries(all, true).map(e => e.slug)).toEqual(['c', 'b', 'a']);
  });

  it('finds a note by slug or display name', () => {
    const all = [{ ...entry('rc-billing', '2026-11-14T00:00:00Z'), meta: { ...meta, name: 'RC billing' } }];
    expect(findEntry(all, 'RC Billing')?.slug).toBe('rc-billing');
    expect(findEntry(all, 'rc-billing')?.slug).toBe('rc-billing');
    expect(findEntry(all, 'nope')).toBeUndefined();
  });
});
