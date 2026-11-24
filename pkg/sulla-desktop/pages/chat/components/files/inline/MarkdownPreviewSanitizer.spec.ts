// @vitest-environment jsdom
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { MarkdownPreviewSanitizer } from './MarkdownPreviewSanitizer';

describe('MarkdownPreviewSanitizer', () => {
  it('uses the shared sanitized Markdown renderer and strips embedded remote resources', () => { // risk: opening a Markdown file must not trigger remote fetches or execute active markup
    const html = new MarkdownPreviewSanitizer().render('# Plan\n\n<script>window.secret = true</script>\n\n![tracking pixel](https://outside.invalid/pixel.png)\n\n<audio src="https://outside.invalid/audio.mp3"></audio>');

    expect(html).toContain('<h1>Plan</h1>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('outside.invalid');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<audio');
  });
});
