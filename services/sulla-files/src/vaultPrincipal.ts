import type { Config } from './config.js';
import type pg from 'pg';

interface CollectionOwnerRow { id:string; owner_user_id:string }

export async function adoptVaultPrincipal(db:pg.Pool, config:Pick<Config, 'userId'>, principalId:string):Promise<void> {
  if (config.userId === principalId) return;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const rows = (await client.query<CollectionOwnerRow>('SELECT id::text,owner_user_id FROM collections FOR UPDATE')).rows;
    if (config.userId !== 'desktop-user' || (rows.length > 0 && !rows.some(row => row.owner_user_id === config.userId || row.owner_user_id === principalId))) {
      throw new Error('Existing Files collections belong to another principal; secure migration is required');
    }
    const sentinelIds = rows.filter(row => row.owner_user_id === config.userId).map(row => row.id);
    if (sentinelIds.length && (await client.query(
      'SELECT 1 FROM files_collection_key_bundles WHERE collection_id=ANY($1::uuid[]) AND principal_id<>$2 LIMIT 1',
      [sentinelIds, principalId],
    )).rowCount) throw new Error('Existing Files collections belong to another principal; secure migration is required');
    if (sentinelIds.length) {
      await client.query(
        `INSERT INTO collection_acl(collection_id,principal_type,principal_id,role)
         SELECT id,'user',$2,'manage' FROM collections WHERE id=ANY($1::uuid[])
         ON CONFLICT(collection_id,principal_type,principal_id) DO UPDATE SET role='manage'`,
        [sentinelIds, principalId],
      );
      await client.query(
        `DELETE FROM collection_acl a USING collections c
          WHERE a.collection_id=c.id AND c.id=ANY($1::uuid[])
            AND a.principal_type='user' AND a.principal_id=c.owner_user_id`,
        [sentinelIds],
      );
      await client.query(
        `UPDATE file_share_links links SET owner_user_id=$2
          WHERE links.owner_user_id=$3 AND (
            links.collection_id=ANY($1::uuid[])
            OR EXISTS(SELECT 1 FROM files WHERE files.id=links.file_id AND files.collection_id=ANY($1::uuid[]))
          )`,
        [sentinelIds, principalId, config.userId],
      );
      await client.query('UPDATE collections SET owner_user_id=$2,updated_at=NOW() WHERE id=ANY($1::uuid[])', [sentinelIds, principalId]);
    }
    await client.query('COMMIT');
    config.userId = principalId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
