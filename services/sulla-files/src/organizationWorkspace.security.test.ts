import assert from 'node:assert/strict';
import test from 'node:test';

import { ROLE_LEVEL, resolveCollectionGrants } from './acl.js';
import type { FilesIdentity } from './auth.js';

const collections = [
  { id:'org-workspace-a',org_id:'org-a',owner_user_id:'org:org-a',workspace_scope:'organization',published:true,legacy_source:false },
  { id:'org-workspace-b',org_id:'org-b',owner_user_id:'org:org-b',workspace_scope:'organization',published:true,legacy_source:false },
  { id:'private-a',org_id:'org-a',owner_user_id:'private-owner',workspace_scope:'principal',is_default:true,published:true,legacy_source:false },
];

function databases(vaultRoles:Record<string,string>) {
  const db:any = { query:async(sql:string,params:any[] = []) => {
    if (sql.startsWith('SELECT * FROM collections')) return { rows:collections.filter(collection=>collection.id===params[0]),rowCount:1 };
    if (sql.startsWith('SELECT role FROM collection_acl')) return { rows:[],rowCount:0 };
    if (sql.startsWith('SELECT folder_path')) return { rows:[],rowCount:0 };
    if (sql.startsWith('SELECT s.file_id')) return { rows:[],rowCount:0 };
    throw new Error(`unexpected Files query: ${sql}`);
  } };
  const identityDb:any = { query:async(sql:string,params:any[] = []) => {
    if (sql.includes('FROM org_members')) {
      const role=vaultRoles[`${params[0]}:${params[1]}`];
      return { rows:role?[{ role }]:[],rowCount:role?1:0 };
    }
    if (sql.includes('FROM group_members')) return { rows:[],rowCount:0 };
    throw new Error(`unexpected identity query: ${sql}`);
  } };
  return { db,identityDb };
}

function actor(userId:string,orgId:string,orgRoles:string[]):FilesIdentity {
  return { userId,deviceId:'',kind:'server-session',orgId,orgRoles };
}

test('organization workspace follows selected-org roles without widening private collections',async()=>{
  const { db,identityDb }=databases({ 'admin-a:org-a':'member','editor-a:org-a':'member','member-a:org-a':'member','private-owner:org-a':'member','other-org:org-b':'owner' });

  assert.equal((await resolveCollectionGrants(db,identityDb,actor('admin-a','org-a',['admin']),'org-workspace-a')).role,'manage');
  assert.equal((await resolveCollectionGrants(db,identityDb,actor('editor-a','org-a',['editor']),'org-workspace-a')).role,'edit');
  const member=await resolveCollectionGrants(db,identityDb,actor('member-a','org-a',['member']),'org-workspace-a');
  assert.equal(member.role,'view');
  assert(ROLE_LEVEL[member.role!] < ROLE_LEVEL.edit);
  assert.equal((await resolveCollectionGrants(db,identityDb,actor('admin-a','org-a',[]),'org-workspace-a')).role,undefined,
    'a current empty Accounts role set must not fall back to a stale identity-database role');

  const crossOrg=await resolveCollectionGrants(db,identityDb,actor('other-org','org-b',['owner']),'org-workspace-a');
  assert.equal(crossOrg.role,undefined);
  assert.deepEqual(crossOrg.paths,[]);
  assert.deepEqual(crossOrg.files,[]);

  const privateMember=await resolveCollectionGrants(db,identityDb,actor('member-a','org-a',['member']),'private-a');
  assert.equal(privateMember.role,undefined);
  assert.equal((await resolveCollectionGrants(db,identityDb,actor('private-owner','org-a',['member']),'private-a')).role,'manage');
});
