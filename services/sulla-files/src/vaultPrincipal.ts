import type pg from 'pg';
import type { Config } from './config.js';

export async function adoptVaultPrincipal(db:pg.Pool, config:Pick<Config, 'userId'>, principalId:string):Promise<void> {
  if (config.userId === principalId) return;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const owners = (await client.query<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM collections FOR UPDATE',
    )).rows;
    const foreignBundle = (await client.query(
      'SELECT 1 FROM files_collection_key_bundles WHERE principal_id<>$1 LIMIT 1', [principalId],
    )).rowCount;
    // A restarted process loads its configured sentinel again, while ownership
    // already belongs to the same authenticated Vault principal.
    if (config.userId === 'desktop-user' && !foreignBundle && owners.every(row => row.owner_user_id === principalId)) {
      await client.query('COMMIT');
      config.userId = principalId;
      return;
    }
    if (config.userId !== 'desktop-user' || owners.some(row => row.owner_user_id !== config.userId) || foreignBundle) {
      throw new Error('Existing Files collections belong to another principal; secure migration is required');
    }
    await client.query(
      `INSERT INTO collection_acl(collection_id,principal_type,principal_id,role)
       SELECT id,'user',$2,'manage' FROM collections WHERE owner_user_id=$1
       ON CONFLICT(collection_id,principal_type,principal_id) DO UPDATE SET role='manage'`,
      [config.userId, principalId],
    );
    await client.query("DELETE FROM collection_acl WHERE principal_type='user' AND principal_id=$1", [config.userId]);
    await client.query('UPDATE file_share_links SET owner_user_id=$2 WHERE owner_user_id=$1', [config.userId, principalId]);
    await client.query('UPDATE collections SET owner_user_id=$2,updated_at=NOW() WHERE owner_user_id=$1', [config.userId, principalId]);
    await client.query('COMMIT');
    config.userId = principalId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
