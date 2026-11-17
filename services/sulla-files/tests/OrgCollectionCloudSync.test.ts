// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {describe,expect,it,vi} from 'vitest';
import {OrgCollectionCloudSync} from '../src/cloudSync/OrgCollectionCloudSync.js';
import {OrgRootKeyCache} from '../src/cloudSync/OrgRootKeyCache.js';
import {transportWrapBytes} from '../src/cloudSync/envelope.js';

const collectionId='11111111-1111-4111-8111-111111111111';

describe('OrgCollectionCloudSync',()=>{
  it('installs a transported root once, then enables sync without Vault operations',async()=>{
    // risk: key custody and data integrity — recipient roots must be single-use and adoption must not create/escrow.
    const repository={enrolledOrgCollection:vi.fn(async()=>true),enableOrgSync:vi.fn(async()=>{})};
    const cache=new OrgRootKeyCache(); const changed=vi.fn();
    const sync=new OrgCollectionCloudSync(repository,cache,changed);
    const request=await sync.requestTransport(); const root=Buffer.alloc(32,0x71);
    const envelope=await transportWrapBytes(root,request.recipientPublicKey,request.requestId,collectionId,3);
    await sync.installRoot({collectionId,requestId:request.requestId,keyVersion:3,transport:envelope});
    expect(await cache.get(collectionId,3)).toEqual(root);
    await expect(sync.installRoot({collectionId,requestId:request.requestId,keyVersion:3,transport:envelope})).rejects.toMatchObject({status:409});
    await sync.enable(collectionId,3,null);
    expect(repository.enableOrgSync).toHaveBeenCalledWith(collectionId,3);
    expect(changed).toHaveBeenCalledWith(collectionId);
  });

  it('refuses sync until this key version has been handed off',async()=>{
    // risk: permissions and key custody — an enrolled row must never begin an unusable sync session.
    const repository={enrolledOrgCollection:vi.fn(async()=>true),enableOrgSync:vi.fn(async()=>{})};
    const sync=new OrgCollectionCloudSync(repository,new OrgRootKeyCache(),()=>{});
    await expect(sync.enable(collectionId,8)).rejects.toMatchObject({status:409});
    expect(repository.enableOrgSync).not.toHaveBeenCalled();
  });
});
