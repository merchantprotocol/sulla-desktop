// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {describe,expect,it} from 'vitest';
import {OrgRootKeyCache,OrgRootKeyUnavailableError} from '../src/cloudSync/OrgRootKeyCache.js';

describe('OrgRootKeyCache',()=>{
  it('keeps independent roots volatile and zeroes returned cache copies on clear',async()=>{
    // risk: key custody — Files must not persist org roots and lock/unenroll must erase volatile copies.
    const cache=new OrgRootKeyCache(); const root=Buffer.alloc(32,0x5a);
    cache.set('collection-a',2,root); cache.set('collection-a',3,Buffer.alloc(32,0x33));
    root.fill(0);
    const installed=await cache.get('collection-a',2);
    expect(installed).toEqual(Buffer.alloc(32,0x5a)); expect(cache.has('collection-a',3)).toBe(true);
    cache.clear('collection-a',2);
    expect(installed).toEqual(Buffer.alloc(32,0x5a)); // returned copy is caller-owned
    installed.fill(0); expect(await cache.get('collection-a',3)).toEqual(Buffer.alloc(32,0x33));
    cache.clear(); await expect(cache.get('collection-a',3)).rejects.toBeInstanceOf(OrgRootKeyUnavailableError);
  });
});

describe('OrgRootKeyCache profile scope', () => {
  it('keeps two profiles\' org roots apart and zeroizes only the invalidated profile', async () => {
    // risk: tenant isolation — one account must never read another account's org root.
    // risk: key lifecycle — invalidating a signed-out profile erases its bytes and keeps the other profile's roots.
    let active = 'profile_a';
    const cache = new OrgRootKeyCache(() => active);
    const rootA = Buffer.alloc(32, 0x11); const rootB = Buffer.alloc(32, 0x22);
    cache.set('collection-1', 1, rootA);
    active = 'profile_b';
    expect(cache.has('collection-1', 1)).toBe(false);
    await expect(cache.get('collection-1', 1)).rejects.toBeInstanceOf(OrgRootKeyUnavailableError);
    cache.set('collection-1', 1, rootB);
    const heldA = (() => { active = 'profile_a'; return cache['profiles'].get('profile_a')!.get('collection-1:1')! })();
    cache.invalidateProfile('profile_a');
    expect(heldA.every(byte => byte === 0)).toBe(true);
    active = 'profile_a';
    await expect(cache.get('collection-1', 1)).rejects.toBeInstanceOf(OrgRootKeyUnavailableError);
    active = 'profile_b';
    expect(await cache.get('collection-1', 1)).toEqual(Buffer.alloc(32, 0x22));
  });
});
