// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { CsvPreviewParser } from '@pkg/pages/chat/components/files/inline/CsvPreviewParser';
import { InlineCodeHighlighter } from '@pkg/pages/chat/components/files/inline/InlineCodeHighlighter';
import { MarkdownEditSession } from '@pkg/pages/chat/components/files/inline/MarkdownEditSession';
import { MarkdownPreviewSanitizer } from '@pkg/pages/chat/components/files/inline/MarkdownPreviewSanitizer';

describe('inline text preview models', () => {
  describe('CsvPreviewParser', () => {
    it('keeps quoted commas, escaped quotes, and embedded newlines in one field', () => { // risk: data accuracy in imported-looking records
      const preview = new CsvPreviewParser().parse('name,notes\r\nAda,"first, line\r\nnext ""step"""');

      expect(preview.headers).toEqual(['name', 'notes']);
      expect(preview.rows).toEqual([['Ada', 'first, line\r\nnext "step"']]);
      expect(preview.totalRows).toBe(1);
      expect(preview.malformed).toBe(false);
    });

    it('caps retained rows and columns while keeping a truthful total only for complete input', () => { // risk: a large table must not exhaust the transcript renderer
      const parser = new CsvPreviewParser();
      const complete = parser.parse('a,b,c\n1,2,3\n4,5,6', { maxRows: 1, maxColumns: 2 });
      const partial = parser.parse('a,b\n1,2\n3,4', { maxRows: 1, sourceComplete: false });

      expect(complete.headers).toEqual(['a', 'b']);
      expect(complete.rows).toEqual([['1', '2']]);
      expect(complete.totalRows).toBe(2);
      expect(complete.hasMoreColumns).toBe(true);
      expect(partial.rows).toEqual([['1', '2']]);
      expect(partial.totalRows).toBeUndefined();
      expect(partial.hasMoreRows).toBeUndefined();
      expect(partial.truncated).toBe(true);
    });

    it('marks an unmatched quote instead of silently presenting a complete record', () => { // risk: data accuracy on malformed exports
      const preview = new CsvPreviewParser().parse('name,notes\nAda,"unfinished');

      expect(preview.rows).toEqual([['Ada', 'unfinished']]);
      expect(preview.malformed).toBe(true);
    });
  });

  describe('MarkdownEditSession', () => {
    it('requires authorized complete Markdown and an explicit original version token before editing', () => { // risk: unauthorized or partial writes can overwrite inaccessible source data
      expect(new MarkdownEditSession({ content: '# private', versionToken: 'v1', authorized: false, complete: true }).beginEdit()).toBe(false);
      expect(new MarkdownEditSession({ content: '# partial', versionToken: 'v1', authorized: true, complete: false }).beginEdit()).toBe(false);
      expect(new MarkdownEditSession({ content: '# no token', authorized: true, complete: true }).beginEdit()).toBe(false);
    });

    it('emits the original version token and preserves the draft on conflict and external change', () => { // risk: stale saves must not discard edits or overwrite a newer Files version
      const session = new MarkdownEditSession({ content: '# original', versionToken: 'version-1', authorized: true, complete: true });
      expect(session.beginEdit()).toBe(true);
      session.setDraft('# Jonathon\'s draft');

      const request = session.requestSave();
      expect(request).toMatchObject({ content: '# Jonathon\'s draft', baseVersionId: 'version-1' });
      expect(request).not.toBeNull();
      session.resolveSave({ requestId: request!.requestId, status: 'conflict', currentVersionToken: 'version-2' });

      expect(session.snapshot()).toMatchObject({ editing: true, draft: '# Jonathon\'s draft', externalChange: true, canSave: false, saveStatus: 'conflict' });
      session.discardDraft();
      expect(session.snapshot().editing).toBe(false);
    });

    it('keeps a failed save retryable with the same base token and the original draft', () => { // risk: a transient failure must not silently lose user edits
      const session = new MarkdownEditSession({ content: '# original', versionToken: 'version-3', authorized: true, complete: true });
      session.beginEdit();
      session.setDraft('# keep this draft');
      const request = session.requestSave();
      expect(request).not.toBeNull();

      session.resolveSave({ requestId: request!.requestId, status: 'error', message: 'offline' });
      expect(session.snapshot()).toMatchObject({ draft: '# keep this draft', editing: true, canSave: true, saveStatus: 'error' });
      expect(session.requestSave()).toMatchObject({ content: '# keep this draft', baseVersionId: 'version-3' });
    });

    it('keeps a draft when the same file changes outside the editor', () => { // risk: refreshes must not replace unsaved user-authored content
      const session = new MarkdownEditSession({ content: '# original', versionToken: 'v4', authorized: true, complete: true });
      session.beginEdit();
      session.setDraft('# local draft');
      session.updateSource({ content: '# external update', versionToken: 'v5', authorized: true, complete: true });

      expect(session.snapshot()).toMatchObject({ draft: '# local draft', externalChange: true, canSave: false });
    });
  });

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

  describe('InlineCodeHighlighter security policy', () => {
    it('escapes source markup before rendering', () => { // risk: source text must never become executable preview markup
      const preview = new InlineCodeHighlighter().highlight('const payload = "<img src=x onerror=alert(1)>";', 'service.ts');

      expect(preview.lines[0].html).toContain('&lt;img');
      expect(preview.lines[0].html).not.toContain('<img');
    });
  });
});
