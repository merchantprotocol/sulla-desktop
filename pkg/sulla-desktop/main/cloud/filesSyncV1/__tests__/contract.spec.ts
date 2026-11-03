// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { deviceMessage } from '../../deviceKey';
import { requireHumanFilesSync, restoreMissingCloudCollections } from '..';

describe('Files sync v1 signed and human-only contracts',()=>{
  test('signature message has the binding purpose and exact parts order',()=>{
    expect(deviceMessage('files-sync-v1',['user','device','collection','commit','abc',123])).toBe('sulla-files-sync-v1\nuser\ndevice\ncollection\ncommit\nabc\n123');
  });
  test('agents cannot change backup or invoke restore',()=>{
    expect(()=>requireHumanFilesSync({kind:'agent',agentId:'untrusted'})).toThrow('Only the person using this desktop');
    expect(()=>requireHumanFilesSync({kind:'human'})).not.toThrow();
  });
});

describe('automatic Cloud collection discovery',()=>{
  const remote={collectionId:'0b6f0c32-4d1e-4c8a-9a59-2f9f6d1e0a11',status:'active',keyVersion:1,headSeq:1,bytes:12,updatedAt:'2026-11-03T20:00:00Z',sourceDeviceId:'mobile',local:false};

  test('restores a collection first created by Mobile',async()=>{
    const restore=jest.fn().mockResolvedValue({restored:[remote.collectionId],failed:[]});
    await expect(restoreMissingCloudCollections(async()=>({collections:[remote]}),restore)).resolves.toEqual({restored:[remote.collectionId],failed:[]});
    expect(restore).toHaveBeenCalledTimes(1);
  });

  test('does not restore or re-upload a collection already present locally',async()=>{
    const restore=jest.fn();
    await expect(restoreMissingCloudCollections(async()=>({collections:[{...remote,local:true}]}),restore)).resolves.toBeNull();
    expect(restore).not.toHaveBeenCalled();
  });
});
