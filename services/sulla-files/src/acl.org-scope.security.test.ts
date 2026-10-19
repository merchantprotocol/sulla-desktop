import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCollectionMembership, requireOrganizationScope, resolveCollectionGrants, searchableScopes } from './acl.js';
import type { FilesIdentity } from './auth.js';

test('organization scope fences shared owners before grants and prepared memberships, without breaking unscoped Desktop access', async() => {
  const actor:FilesIdentity = { userId:'shared-owner', deviceId:'', kind:'server-session', orgId:'org-a' };
  const collections = ['org-a', 'org-b', null].map((org_id, index) => ({ id:`collection-${index}`, org_id, owner_user_id:actor.userId }));
  const db:any = { query:async(sql:string, params:any[] = []) => ({ rows:sql.startsWith('SELECT id FROM collections') ? collections : collections.filter(c => c.id === params[0]), rowCount:1 }) };
  const identityDb:any = { query:async() => ({ rows:[], rowCount:1 }) }; // User is a member of both organizations.
  assert.equal((await resolveCollectionGrants(db, identityDb, actor, 'collection-0')).role, 'manage');
  for (const id of ['collection-1', 'collection-2']) {
    const grants = await resolveCollectionGrants(db, identityDb, actor, id);
    assert.equal(grants.role, undefined);
    assert.deepEqual(grants.paths, []);
    assert.deepEqual(grants.files, []);
    await assert.rejects(prepareCollectionMembership(db, identityDb, actor, id), { status:403 });
    assert.equal((await resolveCollectionGrants(db, undefined, actor, id, { orgId:collections.find(c => c.id === id)!.org_id, member:true, groups:[] })).role, undefined);
  }
  assert.deepEqual((await searchableScopes(db, identityDb, actor)).map(s => s.collectionId), ['collection-0']);
  assert.throws(() => requireOrganizationScope(actor, 'org-b'), { status:403 });
  assert.throws(() => requireOrganizationScope(actor, null), { status:403 });
  const desktop = { ...actor, orgId:undefined };
  assert.equal((await resolveCollectionGrants(db, undefined, desktop, 'collection-2')).role, 'manage');
  assert.equal((await prepareCollectionMembership(db, undefined, desktop, 'collection-2')).member, true);
});
