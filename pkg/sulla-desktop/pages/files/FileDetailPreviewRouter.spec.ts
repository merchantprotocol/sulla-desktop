/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { FileDetailPreviewRouter } from './FileDetailPreviewRouter';

describe('FileDetailPreviewRouter', () => {
  it('keeps Markdown, text, and MP4 preview behavior', () => {
    const router = new FileDetailPreviewRouter();

    // risk: incorrect file routing can expose a raw document as a media placeholder.
    expect(router.resolve('readme.md', 'application/octet-stream')).toEqual({ kind: 'document', documentType: 'markdown' });
    expect(router.resolve('plain.txt', 'text/plain')).toEqual({ kind: 'document', documentType: 'text' });
    expect(router.resolve('recording.mp4', 'video/mp4')).toEqual({ kind: 'video' });
  });
});
