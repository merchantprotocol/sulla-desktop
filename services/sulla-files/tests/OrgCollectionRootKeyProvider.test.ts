// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { OrgRootKeyProvider } from '../src/cloudSync/keyStore.js';

describe('OrgRootKeyProvider', () => {
  it('loads collection roots through the org key source without serializing root material', async() => {
    // risk: key custody — organization roots must never be persisted as local/vault escrow.
    const root=Buffer.alloc(32,0x5a);
    const source={get:vi.fn(async(collectionId:string,keyVersion:number) => {
      expect(collectionId).toBe('collection-1'); expect(keyVersion).toBe(4); return root;
    })};
    const provider=new OrgRootKeyProvider(source);
    const created=await provider.create('collection-1',4);
    expect(created.root).toEqual(root);
    expect(JSON.stringify(created.wrapped)).not.toContain(root.toString('base64'));
    expect(await provider.unwrap('collection-1',4,created.wrapped)).toEqual(root);
    expect(source.get).toHaveBeenCalledTimes(2);
    created.root.fill(0);
  });
});
