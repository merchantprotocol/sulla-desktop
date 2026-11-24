// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { CsvPreviewParser } from './CsvPreviewParser';

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
