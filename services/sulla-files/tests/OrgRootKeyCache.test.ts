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
