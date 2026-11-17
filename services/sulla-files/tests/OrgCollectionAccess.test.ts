// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { CollectionAccessResolver } from '../src/acl.js';

const orgCollection = (level: string) => ({
  id: 'org-1',
  workspace_scope: 'organization',
  owner_user_id: 'user-1',
  org_collection_enrolled: true,
  org_collection_level: level,
});
const repositoryFor = (collection: any) => ({ findAccessible: vi.fn(async () => collection) });
const human = { kind: 'capability', userId: 'user-1', deviceId: 'd' } as any;
const agent = { kind: 'capability', userId: 'user-1', deviceId: 'd', agentId: 'a' } as any;

describe('organization collection access', () => {
  it('gives an agent of a view-level human view only', async() => {
    // risk: permissions — an agent never exceeds its human's org grant.
    const resolver = new CollectionAccessResolver(repositoryFor(orgCollection('view')) as any);
    expect((await resolver.resolve(agent, 'org-1')).role).toBe('view');
  });

  it('gives an agent of an edit-level human edit', async() => {
    // risk: permissions — an agent of an edit grant can write, and no more.
    const resolver = new CollectionAccessResolver(repositoryFor(orgCollection('edit')) as any);
    expect((await resolver.resolve(agent, 'org-1')).role).toBe('edit');
  });

  it('caps an agent of a manage-level human at edit', async() => {
    // risk: permissions — an agent must never manage an organization collection.
    const resolver = new CollectionAccessResolver(repositoryFor(orgCollection('manage')) as any);
    expect((await resolver.resolve(agent, 'org-1')).role).toBe('edit');
  });

  it('denies an agent scoped to a different collection', async() => {
    // risk: tenant isolation — an agent bound to one collection cannot reach another.
    const resolver = new CollectionAccessResolver(repositoryFor(orgCollection('manage')) as any);
    await expect(resolver.resolve({ ...agent, collectionId: 'other' }, 'org-1')).rejects.toMatchObject({ status: 403 });
  });

  it('denies a human when the org level is none', async() => {
    // risk: permissions — no org grant means no access for the human.
    const resolver = new CollectionAccessResolver(repositoryFor(orgCollection('none')) as any);
    await expect(resolver.resolve(human, 'org-1')).rejects.toMatchObject({ status: 403 });
  });

  it('denies an agent when the org level is none', async() => {
    // risk: permissions — an agent of a human with no org grant gets nothing.
    const resolver = new CollectionAccessResolver(repositoryFor(orgCollection('none')) as any);
    await expect(resolver.resolve(agent, 'org-1')).rejects.toMatchObject({ status: 403 });
  });

  it('keeps personal collection resolution unchanged', async() => {
    // risk: permissions — org ACL changes must not alter principal collection access.
    const repository = repositoryFor({ id: 'personal', workspace_scope: 'principal' });
    expect((await new CollectionAccessResolver(repository as any).resolve(human, 'personal')).role).toBe('manage');
  });
});
