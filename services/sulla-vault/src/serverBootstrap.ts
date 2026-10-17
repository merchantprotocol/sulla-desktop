import { makeLoginVerifier } from './auth.js';

import type { Database } from './db.js';

export interface ServerBootstrapMaterial {
  email:               string;
  displayName:         string;
  loginHash:           string;
  publicKey:           string;
  encryptedPrivateKey: Record<string, unknown>;
  encryptedUserKey:    Record<string, unknown>;
  kdf:                 Record<string, unknown>;
  encryptedOrgName:    Record<string, unknown>;
  wrappedOrgKey:       Record<string, unknown>;
}

export async function bootstrapFirstOwner(
  db: Database,
  material: ServerBootstrapMaterial,
): Promise<'created' | 'already_bootstrapped'> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sulla-vault-server-bootstrap'))");
    const existing = await client.query('SELECT 1 FROM users LIMIT 1');
    if (existing.rowCount) {
      await client.query('COMMIT');
      return 'already_bootstrapped';
    }
    const { salt, verifier } = makeLoginVerifier(material.loginHash);
    const user = await client.query<{ id: string }>(
      `INSERT INTO users(email, display_name, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [material.email, material.displayName, salt, verifier, material.publicKey, material.encryptedPrivateKey,
        material.encryptedUserKey, material.kdf],
    );
    const org = await client.query<{ id: string }>(
      'INSERT INTO orgs(encrypted_name, created_by) VALUES ($1,$2) RETURNING id',
      [material.encryptedOrgName, user.rows[0].id],
    );
    await client.query(
      `INSERT INTO org_members(org_id,user_id,role,wrapped_org_key,status)
       VALUES ($1,$2,'owner',$3,'confirmed')`,
      [org.rows[0].id, user.rows[0].id, material.wrappedOrgKey],
    );
    await client.query('COMMIT');
    return 'created';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
