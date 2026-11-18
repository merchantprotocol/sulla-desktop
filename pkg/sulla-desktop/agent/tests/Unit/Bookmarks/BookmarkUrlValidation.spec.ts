// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity and code execution — only safe schemes may be stored as bookmark URLs.
import { describe, expect, it } from 'vitest';

import { normalizeBookmarkUrl } from '@pkg/agent/database/models/BrowserBookmarkModel';

describe('normalizeBookmarkUrl with sulla-file references', () => {
  it('accepts a sulla-file reference with a valid id and returns it unchanged', () => {
    const url = 'sulla-file://file_abc-123?path=Mentors%2Fmain.html&name=main.html';

    expect(normalizeBookmarkUrl(`  ${ url }  `)).toBe(url);
  });

  it.each([
    'sulla-file://bad.id?path=x.md',
    'sulla-file://bad/id?path=x.md',
    'sulla-file://abc?name=x.md',
  ])('rejects a malformed sulla-file reference: %s', url => {
    expect(() => normalizeBookmarkUrl(url)).toThrow('Bookmark URL is invalid');
  });

  it('keeps the existing scheme rules for other URLs', () => {
    expect(normalizeBookmarkUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(normalizeBookmarkUrl('sulla-artifact://art_1')).toBe('sulla-artifact://art_1');
    expect(() => normalizeBookmarkUrl('javascript:alert(1)')).toThrow('not allowed');
    expect(() => normalizeBookmarkUrl('data:text/html,hi')).toThrow('not allowed');
  });
});
