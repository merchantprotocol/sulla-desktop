// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe,expect,it,vi } from 'vitest';
import { ListingPage } from '../src/ListingPage.js';

describe('ListingPage',()=>{
  it('keeps paging opt-in so legacy callers are not silently truncated',()=>{
    // risk: data loss from clients treating a partial listing as complete.
    expect(ListingPage.isRequested(undefined,undefined)).toBe(false);
    expect(ListingPage.isRequested('250',undefined)).toBe(true);
    expect(ListingPage.isRequested(undefined,'cursor')).toBe(true);
  });

  it('caps page size and decodes a path cursor for keyset continuation',()=>{
    // risk: memory grows with collection size if a client can request an unbounded page.
    const page=ListingPage.parse('900000',Buffer.from('folder/file-250.txt').toString('base64url'));
    expect(page.limit).toBe(500);
    expect(page.after).toBe('folder/file-250.txt');
  });

  it('rejects malformed cursors instead of restarting at the first page',()=>{
    // risk: malformed cursors can repeat data indefinitely or silently skip the requested range.
    expect(()=>ListingPage.parse('250','%%%')).toThrow('invalid listing cursor');
  });

  it('emits a continuation cursor only when another bounded page exists',()=>{
    // risk: missing continuation loses files; emitting stale cursors can duplicate pages.
    const response={setHeader:vi.fn()};
    ListingPage.parse(undefined,undefined).apply(response,true,'file-250.txt');
    expect(response.setHeader).toHaveBeenCalledWith('X-Has-More','true');
    expect(response.setHeader).toHaveBeenCalledWith('X-Next-Cursor',Buffer.from('file-250.txt').toString('base64url'));
    response.setHeader.mockClear();
    ListingPage.parse(undefined,undefined).apply(response,false,'file-250.txt');
    expect(response.setHeader).toHaveBeenCalledTimes(1);
  });
});
