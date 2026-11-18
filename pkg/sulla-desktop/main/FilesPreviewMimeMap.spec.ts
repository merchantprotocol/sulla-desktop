// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { FilesPreviewMimeMap } from './FilesPreviewMimeMap';

describe('FilesPreviewMimeMap', () => {
  // risk: content handling — active document assets get their extension MIME, unknown types download as inert octets.
  it('maps preview assets and marks unknown types as attachment', () => {
    const map = new FilesPreviewMimeMap();
    expect(map.get('index.html')).toEqual({ mime:'text/html; charset=utf-8', attachment:false });
    expect(map.get('assets/app.js').mime).toBe('text/javascript; charset=utf-8');
    expect(map.get('font.woff2').mime).toBe('font/woff2');
    expect(map.get('unknown.bin')).toEqual({ mime:'application/octet-stream', attachment:true });
  });
});
