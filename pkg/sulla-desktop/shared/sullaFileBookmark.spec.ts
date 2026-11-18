// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity — a sulla-file bookmark must resolve to exactly one Files document id.
import { describe, expect, it } from 'vitest';

import { SullaFileBookmarkLink } from './sullaFileBookmark';

describe('SullaFileBookmarkLink.parse', () => {
  it('accepts a chat-style reference and reads fileId, path and name', () => {
    const target = SullaFileBookmarkLink.parse('sulla-file://file_abc-123?version=v9&path=Mentors%2Fintro.html&name=intro.html');

    expect(target).toEqual({ fileId: 'file_abc-123', path: 'Mentors/intro.html', name: 'intro.html' });
  });

  it('derives the name from the path when name is missing', () => {
    expect(SullaFileBookmarkLink.parse('sulla-file://abc?path=Mentors%2Fcourse%2Fmain.html')?.name).toBe('main.html');
  });

  it.each([
    ['a bad id with a slash', 'sulla-file://abc/def?path=x.md'],
    ['an id with a dot', 'sulla-file://abc.def?path=x.md'],
    ['an id with a space', 'sulla-file://ab%20c?path=x.md'],
    ['an empty id', 'sulla-file://?path=x.md'],
    ['an id with a port-like colon', 'sulla-file://abc:80?path=x.md'],
    ['no path', 'sulla-file://abc?name=x.md'],
    ['an empty path', 'sulla-file://abc?path=%20&name=x.md'],
    ['a fragment', 'sulla-file://abc?path=x.md#frag'],
    ['a different scheme spelled like it', 'sulla-files://abc?path=x.md'],
  ])('rejects %s', (_label, url) => {
    expect(SullaFileBookmarkLink.parse(url)).toBeNull();
    expect(SullaFileBookmarkLink.isValid(url)).toBe(false);
  });
});

describe('SullaFileBookmarkLink.build', () => {
  it('builds the bookmark form without a version', () => {
    const url = SullaFileBookmarkLink.build({ id: 'file_1', path: 'Mentors/main.html', name: 'main.html' });

    expect(url).toBe('sulla-file://file_1?path=Mentors%2Fmain.html&name=main.html');
    expect(new URLSearchParams(url.split('?')[1]).has('version')).toBe(false);
  });

  it('refuses an id outside the Files id pattern', () => {
    expect(() => SullaFileBookmarkLink.build({ id: 'bad/id', path: 'x.md' })).toThrow();
  });
});

describe('SullaFileBookmarkLink.isSullaFileUrl', () => {
  it('matches only the sulla-file scheme', () => {
    expect(SullaFileBookmarkLink.isSullaFileUrl('sulla-file://abc?path=x.md')).toBe(true);
    expect(SullaFileBookmarkLink.isSullaFileUrl('sulla-artifact://abc')).toBe(false);
    expect(SullaFileBookmarkLink.isSullaFileUrl('https://example.com')).toBe(false);
    expect(SullaFileBookmarkLink.isSullaFileUrl(null)).toBe(false);
  });
});
