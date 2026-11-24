// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { InlineCodeHighlighter } from './InlineCodeHighlighter';

describe('InlineCodeHighlighter', () => {
  it('highlights common TypeScript tokens and escapes source markup before rendering', () => { // risk: source text must never become executable preview markup
    const preview = new InlineCodeHighlighter().highlight('const payload = "<img src=x onerror=alert(1)>"; // note', 'service.ts');

    expect(preview.lines[0].number).toBe(1);
    expect(preview.lines[0].html).toContain('inline-code-keyword');
    expect(preview.lines[0].html).toContain('inline-code-string');
    expect(preview.lines[0].html).toContain('inline-code-comment');
    expect(preview.lines[0].html).toContain('&lt;img');
    expect(preview.lines[0].html).not.toContain('<img');
  });

  it('marks a clipped preview without claiming an exact total line count', () => { // risk: large authorized source must remain bounded and accurately labeled
    const preview = new InlineCodeHighlighter().highlight('one\ntwo\nthree', 'txt', 2, 100);

    expect(preview.lines.map(line => line.number)).toEqual([1, 2]);
    expect(preview.truncated).toBe(true);
    expect(preview.totalLines).toBeUndefined();
  });
});
