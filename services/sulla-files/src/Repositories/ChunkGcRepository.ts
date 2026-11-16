// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

/** Physical chunk garbage collection: the file_chunk_gc queue and chunk reference accounting. */
export class ChunkGcRepository {
  constructor(private readonly db:Queryable) {}

  async pendingBatch():Promise<pg.QueryResult> {
    return this.db.query('SELECT collection_id,chunk_id,audit_id FROM file_chunk_gc ORDER BY requested_at LIMIT 500');
  }

  /** Blocks concurrent version writes so a reference count cannot change under the caller. */
  async lockVersionsTable(client:Queryable):Promise<void> {
    await client.query('LOCK TABLE file_versions IN SHARE ROW EXCLUSIVE MODE');
  }

  async lockQueued(client:Queryable, collectionId:string, chunkId:string):Promise<{ audit_id:string | null } | undefined> {
    return (await client.query('SELECT audit_id FROM file_chunk_gc WHERE collection_id=$1 AND chunk_id=$2 FOR UPDATE', [collectionId, chunkId])).rows[0];
  }

  /** Number of distinct versions whose manifest still lists the chunk. */
  async countReferences(client:Queryable, collectionId:string, chunkId:string):Promise<number> {
    return Number((await client.query(`SELECT COUNT(DISTINCT v.id)::int refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
        WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2`, [collectionId, chunkId])).rows[0].refs);
  }

  async setRefcount(client:Queryable, collectionId:string, chunkId:string, refs:number):Promise<void> {
    await client.query('UPDATE chunks SET refcount=$3 WHERE collection_id=$1 AND id=$2', [collectionId, chunkId, refs]);
  }

  async deleteChunkRow(client:Queryable, collectionId:string, chunkId:string):Promise<void> {
    await client.query('DELETE FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId, chunkId]);
  }

  async dequeue(client:Queryable, collectionId:string, chunkId:string):Promise<void> {
    await client.query('DELETE FROM file_chunk_gc WHERE collection_id=$1 AND chunk_id=$2', [collectionId, chunkId]);
  }

  async queue(client:Queryable, collectionId:string, chunkId:string, auditId:unknown):Promise<void> {
    await client.query(`INSERT INTO file_chunk_gc(collection_id,chunk_id,audit_id) VALUES($1,$2,$3) ON CONFLICT(collection_id,chunk_id) DO UPDATE SET audit_id=EXCLUDED.audit_id,requested_at=NOW(),last_error=NULL`, [collectionId, chunkId, auditId]);
  }

  async hasPendingForAudit(queryable:Queryable, auditId:unknown):Promise<boolean> {
    return Boolean((await queryable.query('SELECT 1 FROM file_chunk_gc WHERE audit_id=$1 LIMIT 1', [auditId])).rowCount);
  }

  /** Sets audit_log.details.physicalChunkGc ('complete' | 'not-required'). */
  async markAuditChunkGc(queryable:Queryable, auditId:unknown, state:'complete' | 'not-required'):Promise<void> {
    await queryable.query(`UPDATE audit_log SET details=jsonb_set(details,'{physicalChunkGc}',to_jsonb($2::text),TRUE) WHERE id=$1`, [auditId, state]);
  }

  async recordError(queryable:Queryable, collectionId:string, chunkId:string, message:string):Promise<void> {
    await queryable.query('UPDATE file_chunk_gc SET last_error=$3 WHERE collection_id=$1 AND chunk_id=$2', [collectionId, chunkId, message]);
  }
}
