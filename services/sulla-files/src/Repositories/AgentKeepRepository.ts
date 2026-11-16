// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Keeping agent-run files in a permanent collection (SQL moved verbatim from app.ts). */
export class AgentKeepRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>, private readonly fileColumns:string) {}

  async scratchRun(userId:string, runId:string):Promise<any> {
    return (await this.db.query("SELECT * FROM collections WHERE owner_user_id=$1 AND agent_run_id=$2 AND kind='scratch' AND published=TRUE AND legacy_source=FALSE", [userId, runId])).rows[0];
  }

  /** One scratch run's live files (bounded by the run). */
  async runFiles(collectionId:string, runId:string):Promise<any[]> {
    return (await this.db.query(`SELECT ${this.fileColumns} FROM files f WHERE f.collection_id=$1 AND f.created_by_id=$2 AND f.deleted_at IS NULL`, [collectionId, runId])).rows;
  }

  async lockFile(client:pg.PoolClient, fileId:string):Promise<void> {
    await client.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [fileId]);
  }

  async lockFiles(client:pg.PoolClient, fileIds:string[]):Promise<void> {
    await client.query('SELECT id FROM files WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [fileIds]);
  }

  async lockTarget(client:pg.PoolClient, collectionId:string, path:string):Promise<{ id:string } | undefined> {
    return (await client.query('SELECT id FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE', [collectionId, path])).rows[0];
  }

  async trash(client:pg.PoolClient, fileId:string):Promise<void> {
    await client.query('UPDATE files SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [fileId]);
  }

  async recordProvenance(client:pg.PoolClient, keptId:string, runId:string, props:string, createdBy:string):Promise<void> {
    await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,props,created_by) VALUES('file',$1,'agent-run',$2,'created_by',$3,$4) ON CONFLICT DO NOTHING`, [keptId, runId, props, createdBy]);
  }
}
