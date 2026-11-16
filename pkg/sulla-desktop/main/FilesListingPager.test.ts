// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { FilesListingPager } from './FilesListingPager';

/** A fake Files service with `total` rows that honours limit/cursor like GET /v1/files. */
function service(total:number) {
  const urls:string[] = [];
  const request = async(url:string) => {
    urls.push(url);
    const query = new URL(url, 'http://files').searchParams;
    const limit = Number(query.get('limit')); const after = Number(query.get('cursor') ?? -1);
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - after - 1)) }, (_, index) => ({ path: `f${ after + 1 + index }` }));
    const last = after + rows.length; const more = last < total - 1;
    return new Response(JSON.stringify(rows), { headers: more ? { 'X-Has-More': 'true', 'X-Next-Cursor': String(last) } : { 'X-Has-More': 'false' } });
  };
  return { request, urls };
}

describe('FilesListingPager', () => {
  it('visits every row exactly once while holding at most one page', async() => {
    // risk: truncated listings look like deletions to sync; whole-list responses OOM Desktop.
    const files = service(1003); let seen = 0; let largest = 0;
    for await (const page of FilesListingPager.pages<{ path:string }>(files.request, '/v1/files', { collectionId: 'c' }, 100)) { seen += page.length; largest = Math.max(largest, page.length) }
    expect(seen).toBe(1003);
    expect(largest).toBe(100);
    expect(files.urls.every(url => url.includes('limit=100'))).toBe(true);
  });

  it('stops paging as soon as a match is found', async() => {
    // risk: an existence check must not walk a million-file collection.
    const files = service(100_000);
    expect(await FilesListingPager.some<{ path:string }>(files.request, '/v1/files', { collectionId: 'c' }, row => row.path === 'f300')).toBe(true);
    expect(files.urls.length).toBe(2);
  });
});
