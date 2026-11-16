// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Agent artifact writes and the agent's default knowledge collection (SQL moved verbatim from app.ts). */
export class AgentWriteRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async defaultKnowledgeCollection(userId:string, orgId:string | null):Promise<any> {
    return (await this.db.query("SELECT * FROM collections WHERE owner_user_id=$1 AND kind='knowledge' AND compatibility_state='native' AND published=TRUE AND legacy_source=FALSE AND ($2::text IS NULL OR org_id=$2::text) ORDER BY is_default DESC,created_at LIMIT 1", [userId, orgId])).rows[0];
  }

  async insertKnowledgeCollection(client:pg.PoolClient, id:string, orgId:string | null, userId:string, threadId:string | null, kind:string):Promise<any> {
    return (await client.query(`INSERT INTO collections
        (id,org_id,owner_user_id,agent_run_id,thread_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy)
        VALUES($1,$2,$3,$4,$5,$6,$7,'desktop-only',$8,$9,$10) RETURNING *`,
    [id, orgId, userId, null, threadId, 'Knowledge', kind, {}, {}, {}])).rows[0];
  }

  async setCollectionKeys(client:pg.PoolClient, id:string, data:unknown, dedup:unknown):Promise<void> {
    await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1', [id, data, dedup]);
  }

  async lockFileAtPath(client:pg.PoolClient, collectionId:string, path:string):Promise<any> {
    return (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE', [collectionId, path])).rows[0];
  }

  async lockFile(client:pg.PoolClient, fileId:string):Promise<any> {
    return (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
  }

  /** The version an idempotency key already produced, with the file it belongs to. */
  async priorVersion(client:pg.PoolClient, versionId:string):Promise<any> {
    return (await client.query(`SELECT v.id,v.file_id,v.message,f.collection_id,f.path,f.mime,f.created_by_type,f.created_by_id
        FROM file_versions v JOIN files f ON f.id=v.file_id WHERE v.id=$1`, [versionId])).rows[0];
  }

  async derivedSources(client:pg.PoolClient, fileId:string):Promise<string[]> {
    return (await client.query("SELECT dst_id FROM edges WHERE src_type='file' AND src_id=$1 AND kind='derived_from' ORDER BY dst_id", [fileId])).rows.map(row => row.dst_id);
  }

  async clearDerivedSources(client:pg.PoolClient, fileId:string):Promise<void> {
    await client.query("DELETE FROM edges WHERE src_type='file' AND src_id=$1 AND kind='derived_from'", [fileId]);
  }

  async addDerivedSource(client:pg.PoolClient, fileId:string, sourceId:string, createdBy:string):Promise<void> {
    await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES('file',$1,'file',$2,'derived_from',$3) ON CONFLICT DO NOTHING`, [fileId, sourceId, createdBy]);
  }
}
