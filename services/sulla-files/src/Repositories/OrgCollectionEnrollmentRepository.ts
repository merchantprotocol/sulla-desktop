// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** SQL boundary for locally enrolled organization collections. */
export class OrgCollectionEnrollmentRepository {
  constructor(private readonly db:Pick<pg.Pool,'query'>) {}
  async enroll(client:pg.PoolClient,input:{collectionId:string;orgId:string;orgName:string;name:string;creatorUserId:string;userId:string;level:string}):Promise<any> {
    await client.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy,workspace_scope,org_name,cloud_creator_user_id,org_collection_level,root_key_source,org_collection_enrolled,published,explorer_path)
      VALUES($1,$2,$3,$4,'knowledge','synced','org-readable','{}','{}','{}','organization',$5,$6,$7,'org',TRUE,TRUE,$8)
      ON CONFLICT(id) DO UPDATE SET org_id=EXCLUDED.org_id,name=EXCLUDED.name,org_name=EXCLUDED.org_name,cloud_creator_user_id=EXCLUDED.cloud_creator_user_id,org_collection_level=EXCLUDED.org_collection_level,workspace_scope='organization',root_key_source='org',org_collection_enrolled=TRUE,published=TRUE,explorer_path=EXCLUDED.explorer_path,updated_at=NOW()
      WHERE collections.owner_user_id=EXCLUDED.owner_user_id AND collections.workspace_scope='organization' RETURNING id`,[input.collectionId,input.orgId,input.userId,input.name,input.orgName,input.creatorUserId,input.level,`Organizations/${this.safe(input.orgName)}/${this.safe(input.name)} (${input.collectionId.slice(0,8)})`]);
    const enrolled=await client.query(`SELECT * FROM collections WHERE id=$1 AND owner_user_id=$2 AND workspace_scope='organization'`,[input.collectionId,input.userId]);
    return enrolled.rows[0];
  }
  async setKeys(client:pg.PoolClient,collectionId:string,dataKey:unknown,dedupKey:unknown):Promise<void> {
    await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1',[collectionId,dataKey,dedupKey]);
  }
  private safe(name:string):string { return name.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().replace(/[. ]+$/,'') || 'Unnamed' }
  async updateLevel(collectionId:string,userId:string,level:string):Promise<any> {
    return (await this.db.query(`UPDATE collections SET org_collection_level=$3,org_collection_enrolled=TRUE,updated_at=NOW() WHERE id=$1 AND workspace_scope='organization' AND owner_user_id=$2 RETURNING *`,[collectionId,userId,level])).rows[0];
  }
  async unenroll(collectionId:string,userId:string):Promise<boolean> {
    const result=await this.db.query(`UPDATE collections SET org_collection_level='none',org_collection_enrolled=FALSE,updated_at=NOW() WHERE id=$1 AND workspace_scope='organization' AND owner_user_id=$2 RETURNING id`,[collectionId,userId]);
    return result.rowCount===1;
  }
  async list(userId:string):Promise<any[]> {
    return (await this.db.query(`SELECT * FROM collections WHERE owner_user_id=$1 AND workspace_scope='organization' AND org_collection_enrolled=TRUE AND org_collection_level<>'none' AND published=TRUE AND legacy_source=FALSE ORDER BY org_name,name,id`,[userId])).rows;
  }
}
