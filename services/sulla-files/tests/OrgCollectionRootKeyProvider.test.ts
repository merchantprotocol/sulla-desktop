// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { OrgRootKeyProvider } from '../src/cloudSync/keyStore.js';
import { parseRemoteVersion } from '../src/cloudSync/validation.js';

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


describe('organization pull metadata', () => {
  it('retains remote creator identity, including the optional Cloud author user id', () => {
    // risk: data accuracy — a recipient must not become the author of a version created by another org member.
    const parsed=parseRemoteVersion({
      fileId:'11111111-1111-4111-8111-111111111111',
      versionId:'22222222-2222-4222-8222-222222222222',
      parentVersionId:null,deleted:false,chunkIds:[],seq:1,
      manifest:{collectionId:'33333333-3333-4333-8333-333333333333',fileId:'11111111-1111-4111-8111-111111111111',versionId:'22222222-2222-4222-8222-222222222222',keyVersion:1},
      created_by_type:'agent-run',created_by_id:'remote-agent-run',authorUserId:'original-user',
    },'33333333-3333-4333-8333-333333333333',1);
    expect(parsed).toMatchObject({createdByType:'agent-run',createdById:'remote-agent-run',authorUserId:'original-user'});
  });
});
