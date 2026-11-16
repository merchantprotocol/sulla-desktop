// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface NewSystemCollection { id:string; orgId:string | null; ownerUserId:string; name:string; systemArea:string | null; explorerPath:string }

/** Rows that make up the system areas (Files home, internal Logs). Runs on the provisioning transaction's client. */
export class SystemAreaRepository {
  /** Serialises provisioning of one area across service instances. */
  async lockArea(client:pg.PoolClient, areaKey:string):Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`system-area:${ areaKey }`]);
  }

  /** The owner's home collection: published, not legacy, no system area; the managed default first. */
  async findHome(client:pg.PoolClient, userId:string):Promise<any | undefined> {
    return (await client.query("SELECT * FROM collections WHERE owner_user_id=$1 AND system_area IS NULL AND published=TRUE AND legacy_source=FALSE ORDER BY EXISTS(SELECT 1 FROM collection_acl a WHERE a.collection_id=collections.id AND a.principal_type='user' AND a.principal_id=$1 AND a.role='manage') DESC,is_default DESC,created_at LIMIT 1", [userId])).rows[0];
  }

  async findBySystemArea(client:pg.PoolClient, systemArea:string):Promise<any | undefined> {
    return (await client.query('SELECT * FROM collections WHERE system_area=$1', [systemArea])).rows[0];
  }

  /** Inserts the collection with placeholder keys; `setKeys` stores the wrapped keys once the keyring made them. */
  async insertCollection(client:pg.PoolClient, row:NewSystemCollection):Promise<any> {
    return (await client.query(`INSERT INTO collections
          (id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,explorer_path,system_area)
          VALUES($1,$2,$3,$4,'knowledge','desktop-only',$5,$6,'{}',$8,$7) RETURNING *`,
    [row.id, row.orgId, row.ownerUserId, row.name, {}, {}, row.systemArea, row.explorerPath])).rows[0];
  }

  async setKeys(client:pg.PoolClient, collectionId:string, data:unknown, dedup:unknown):Promise<void> {
    await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1', [collectionId, data, dedup]);
  }

  /** Creates the folder, or fills in its description when it has none. */
  async upsertFolder(client:pg.PoolClient, collectionId:string, path:string, description:string | null):Promise<void> {
    await client.query(`INSERT INTO file_folders(collection_id,path,created_by_type,created_by_id,description)
            VALUES($1,$2,'service','sulla-files',$3) ON CONFLICT(collection_id,path) DO UPDATE
            SET description=COALESCE(EXCLUDED.description,file_folders.description)`, [collectionId, path, description]);
  }
}
