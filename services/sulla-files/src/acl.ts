import type { FilesIdentity } from './auth.js';
import type pg from 'pg';

export const ROLE_LEVEL:Record<string, number> = { view: 1, 'use-by-agents': 2, edit: 3, manage: 4 };
export interface CollectionGrant { role?: string; paths: { folderPath: string; role: string }[]; collection: any }
export interface CollectionSearchScope { collectionId: string; paths: string[] }

export async function resolveCollectionGrants(db:pg.Pool | pg.PoolClient, identityDb:pg.Pool | undefined, actor:FilesIdentity, collectionId:string):Promise<CollectionGrant> {
  const result = await db.query('SELECT * FROM collections WHERE id=$1', [collectionId]); const collection = result.rows[0];
  if (!collection) throw Object.assign(new Error('collection not found'), { status: 404 });
  if (collection.owner_user_id === actor.userId) return { role: 'manage', paths: [], collection };
  let groups:string[] = [];
  if (identityDb && collection.org_id) {
    const memberships = await identityDb.query(`SELECT gm.group_id::text FROM group_members gm JOIN org_groups g ON g.id=gm.group_id AND g.org_id=$2 JOIN org_members om ON om.org_id=g.org_id AND om.user_id=gm.user_id AND om.status='confirmed' WHERE gm.user_id=$1`, [actor.userId, collection.org_id]);
    groups = memberships.rows.map(row => row.group_id);
  }
  const acl = await db.query(`SELECT role FROM collection_acl WHERE collection_id=$1 AND ((principal_type='user' AND principal_id=$2) OR (principal_type='group' AND principal_id=ANY($3::text[])))`, [collectionId, actor.userId, groups]);
  const role = acl.rows.map(row => row.role).sort((left, right) => ROLE_LEVEL[right] - ROLE_LEVEL[left])[0];
  const shares = await db.query(`SELECT folder_path,role FROM folder_shares WHERE collection_id=$1 AND ((principal_type='user' AND principal_id=$2) OR (principal_type='group' AND principal_id=ANY($3::text[])))`, [collectionId, actor.userId, groups]);
  return { role, paths: shares.rows.map(row => ({ folderPath: row.folder_path, role: row.role })), collection };
}

export async function searchableScopes(db:pg.Pool, identityDb:pg.Pool | undefined, actor:FilesIdentity):Promise<CollectionSearchScope[]> {
  const collections = await db.query("SELECT id FROM collections WHERE kind='knowledge'"); const scopes:CollectionSearchScope[] = [];
  for (const collection of collections.rows) {
    const access = await resolveCollectionGrants(db, identityDb, actor, collection.id);
    if (access.role && ROLE_LEVEL[access.role] >= ROLE_LEVEL.view) scopes.push({ collectionId: collection.id, paths: [] });
    else {
      const paths = access.paths.filter(grant => ROLE_LEVEL[grant.role] >= ROLE_LEVEL.view).map(grant => grant.folderPath);
      if (paths.length) scopes.push({ collectionId: collection.id, paths });
    }
  }
  return scopes;
}
