// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { CollectionAccessResolver } from '../src/acl.js';

describe('organization collection access', () => {
  it('caps an explicitly authorized agent at view and denies it without the agent policy', async() => {
    // risk: permissions — an agent cannot inherit its human's edit/manage grant without its own policy.
    const collection={id:'org-1',workspace_scope:'organization',owner_user_id:'user-1',org_collection_enrolled:true,org_collection_level:'manage'};
    const repository={findAccessible:vi.fn(async()=>collection),agentCanUse:vi.fn(async()=>true)};
    const resolver=new CollectionAccessResolver(repository as any);
    expect((await resolver.resolve({kind:'capability',userId:'user-1',deviceId:'d',agentId:'a'},'org-1')).role).toBe('edit');
    await expect(resolver.resolve({kind:'capability',userId:'user-1',deviceId:'d',agentId:'a',collectionId:'other'},'org-1')).rejects.toMatchObject({status:403});
    repository.agentCanUse.mockResolvedValue(false);
    await expect(resolver.resolve({kind:'capability',userId:'user-1',deviceId:'d',agentId:'a'},'org-1')).rejects.toMatchObject({status:403});
  });

  it('keeps personal collection resolution unchanged', async() => {
    // risk: permissions — org ACL changes must not alter principal collection access.
    const repository={findAccessible:vi.fn(async()=>({id:'personal',workspace_scope:'principal'})),agentCanUse:vi.fn()};
    expect((await new CollectionAccessResolver(repository as any).resolve({kind:'capability',userId:'user-1',deviceId:'d'},'personal')).role).toBe('manage');
  });
});
