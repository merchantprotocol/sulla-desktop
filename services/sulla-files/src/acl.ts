import type { FilesIdentity } from './auth.js';
import type pg from 'pg';

export const ROLE_LEVEL:Record<string, number> = { view: 1, 'use-by-agents': 2, edit: 3, manage: 4 };
export interface CollectionGrant { role?: string; paths: { folderPath: string; role: string }[]; files: { fileId: string; role: string }[]; collection: any }
export interface CollectionSearchScope { collectionId: string; paths: string[]; fileIds: string[] }

export async function resolveCollectionGrants(db:pg.Pool | pg.PoolClient, identityDb:pg.Pool | undefined, actor:FilesIdentity, collectionId:string):Promise<CollectionGrant> {
  const result = await db.query('SELECT * FROM collections WHERE id=$1 AND published=TRUE AND legacy_source=FALSE', [collectionId]); const collection = result.rows[0];
  if (!collection) throw Object.assign(new Error('collection not found'), { status: 404 });
  let groups:string[] = [];
  if (collection.org_id && identityDb) {
    const member = await identityDb.query(`SELECT 1 FROM org_members om JOIN users u ON u.id=om.user_id WHERE om.org_id=$2 AND om.user_id=$1 AND om.status='confirmed' AND u.disabled_at IS NULL`, [actor.userId, collection.org_id]);
    if (!member.rowCount) return { paths: [], files: [], collection };
    if (collection.owner_user_id === actor.userId) return { role: 'manage', paths: [], files: [], collection };
    const memberships = await identityDb.query(`SELECT gm.group_id::text FROM group_members gm JOIN org_groups g ON g.id=gm.group_id AND g.org_id=$2 WHERE gm.user_id=$1`, [actor.userId, collection.org_id]);
    groups = memberships.rows.map(row => row.group_id);
  }
  if (collection.owner_user_id === actor.userId) return { role: 'manage', paths: [], files: [], collection };
  const acl = await db.query(`SELECT role FROM collection_acl WHERE collection_id=$1 AND ((principal_type='user' AND principal_id=$2) OR (principal_type='group' AND principal_id=ANY($3::text[])))`, [collectionId, actor.userId, groups]);
  const role = acl.rows.map(row => row.role).sort((left, right) => ROLE_LEVEL[right] - ROLE_LEVEL[left])[0];
  const shares = await db.query(`SELECT folder_path,role FROM folder_shares WHERE collection_id=$1 AND ((principal_type='user' AND principal_id=$2) OR (principal_type='group' AND principal_id=ANY($3::text[])))`, [collectionId, actor.userId, groups]);
  const files = await db.query(`SELECT s.file_id::text, s.role FROM file_shares s JOIN files f ON f.id=s.file_id
    WHERE f.collection_id=$1 AND ((s.principal_type='user' AND s.principal_id=$2) OR (s.principal_type='group' AND s.principal_id=ANY($3::text[])))`, [collectionId, actor.userId, groups]);
  return {
    role,
    paths: shares.rows.map(row => ({ folderPath: row.folder_path, role: row.role })),
    files: files.rows.map(row => ({ fileId: row.file_id, role: row.role })),
    collection,
  };
}

export async function searchableScopes(db:pg.Pool, identityDb:pg.Pool | undefined, actor:FilesIdentity):Promise<CollectionSearchScope[]> {
  const collections = await db.query("SELECT id FROM collections WHERE kind='knowledge' AND published=TRUE AND legacy_source=FALSE"); const scopes:CollectionSearchScope[] = [];
  const requiredRole = actor.agentId || actor.jobId ? 'use-by-agents' : 'view';
  for (const collection of collections.rows) {
    const access = await resolveCollectionGrants(db, identityDb, actor, collection.id);
    if (access.role && ROLE_LEVEL[access.role] >= ROLE_LEVEL[requiredRole]) scopes.push({ collectionId: collection.id, paths: [], fileIds: [] });
    else {
      const paths = access.paths.filter(grant => ROLE_LEVEL[grant.role] >= ROLE_LEVEL[requiredRole]).map(grant => grant.folderPath);
      const fileIds = access.files.filter(grant => ROLE_LEVEL[grant.role] >= ROLE_LEVEL[requiredRole]).map(grant => grant.fileId);
      if (paths.length || fileIds.length) scopes.push({ collectionId: collection.id, paths, fileIds });
    }
  }
  return scopes;
}
