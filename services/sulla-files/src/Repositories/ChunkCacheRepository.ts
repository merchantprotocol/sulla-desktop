// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export type ChunkCacheState = 'resident' | 'evicting' | 'evicted';
export interface ChunkCacheKey { collectionId:string; chunkId:string }
export interface EvictionCandidate { collection_id:string; chunk_id:string; stored_bytes:string | number; last_read_at:Date | null }

/**
 * The local chunk cache ledger (files_chunk_cache) plus the two facts eviction must re-check:
 * protected chunks (files_protected_chunks) and the collection's keep_on_computer pin.
 * A chunk only leaves disk through resident → evicting → evicted.
 */
export class ChunkCacheRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** Batched read-access stamp; a chunk not yet in the ledger is recorded as resident. */
  async recordAccess(entries:readonly ChunkCacheKey[]):Promise<void> {
    await this.db.query(`INSERT INTO files_chunk_cache(collection_id,chunk_id,state,last_read_at)
      SELECT collection_id::uuid,chunk_id,'resident',NOW() FROM jsonb_to_recordset($1::jsonb) AS x(collection_id text,chunk_id text)
      ON CONFLICT(collection_id,chunk_id) DO UPDATE SET last_read_at=EXCLUDED.last_read_at`, [JSON.stringify(entries.map(({ collectionId:collection_id, chunkId:chunk_id }) => ({ collection_id, chunk_id })))]);
  }

  async residentBytes():Promise<number> {
    return Number((await this.db.query("SELECT COALESCE(SUM(stored_bytes),0) bytes FROM files_chunk_cache WHERE state='resident'")).rows[0]?.bytes ?? 0);
  }

  /** Oldest-read first (never-read first), skipping chunks read in the last 5 minutes and protected chunks. */
  async evictionCandidates():Promise<EvictionCandidate[]> {
    return (await this.db.query(`SELECT cc.collection_id::text,cc.chunk_id,cc.stored_bytes,cc.last_read_at
      FROM files_chunk_cache cc
      WHERE cc.state='resident' AND (cc.last_read_at IS NULL OR cc.last_read_at < NOW()-INTERVAL '5 minutes')
      AND NOT EXISTS(SELECT 1 FROM files_protected_chunks p WHERE p.collection_id=cc.collection_id AND p.chunk_id=cc.chunk_id)
      ORDER BY cc.last_read_at ASC NULLS FIRST LIMIT 1000`)).rows;
  }

  /** The collection's pin row; undefined when the collection is gone. Throws when the column is missing. */
  async collectionPin(collectionId:string):Promise<{ keep_on_computer:boolean } | undefined> {
    return (await this.db.query('SELECT keep_on_computer FROM collections WHERE id=$1', [collectionId])).rows[0];
  }

  async isProtected(collectionId:string, chunkId:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM files_protected_chunks WHERE collection_id=$1 AND chunk_id=$2', [collectionId, chunkId])).rowCount);
  }

  async lastReadAt(collectionId:string, chunkId:string):Promise<Date | null | undefined> {
    return (await this.db.query('SELECT last_read_at FROM files_chunk_cache WHERE collection_id=$1 AND chunk_id=$2', [collectionId, chunkId])).rows[0]?.last_read_at;
  }

  async state(collectionId:string, chunkId:string):Promise<ChunkCacheState | undefined> {
    return (await this.db.query('SELECT state FROM files_chunk_cache WHERE collection_id=$1 AND chunk_id=$2', [collectionId, chunkId])).rows[0]?.state;
  }

  /** resident → evicting; false when another pass (or a read) already moved it. */
  async beginEviction(collectionId:string, chunkId:string):Promise<boolean> {
    return Boolean((await this.db.query("UPDATE files_chunk_cache SET state='evicting',updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2 AND state='resident' RETURNING stored_bytes", [collectionId, chunkId])).rowCount);
  }

  /** evicting → evicted after the blob was deleted. */
  async completeEviction(collectionId:string, chunkId:string):Promise<void> {
    await this.db.query("UPDATE files_chunk_cache SET state='evicted',stored_bytes=0,evicted_at=NOW(),updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2 AND state='evicting'", [collectionId, chunkId]);
  }

  /** The blob was already gone: record it evicted whatever the current state. */
  async markEvicted(collectionId:string, chunkId:string):Promise<void> {
    await this.db.query("UPDATE files_chunk_cache SET state='evicted',stored_bytes=0,evicted_at=NOW(),updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2", [collectionId, chunkId]);
  }

  /** Eviction failed: the blob is still on disk. */
  async restoreResident(collectionId:string, chunkId:string):Promise<void> {
    await this.db.query("UPDATE files_chunk_cache SET state='resident',updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2", [collectionId, chunkId]);
  }

  /** Hydrated from the cloud copy: resident again with its new stored size. */
  async markHydrated(collectionId:string, chunkId:string, storedBytes:number):Promise<void> {
    await this.db.query("UPDATE files_chunk_cache SET state='resident',stored_bytes=$3,last_read_at=NOW(),updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2", [collectionId, chunkId, storedBytes]);
  }

  /** A local write published the blob. */
  async upsertResident(collectionId:string, chunkId:string, storedBytes:number):Promise<void> {
    await this.db.query(`INSERT INTO files_chunk_cache(collection_id,chunk_id,state,stored_bytes,last_read_at)
      VALUES($1,$2,'resident',$3,NOW()) ON CONFLICT(collection_id,chunk_id) DO UPDATE
      SET state='resident',stored_bytes=EXCLUDED.stored_bytes,evicted_at=NULL,updated_at=NOW()`, [collectionId, chunkId, storedBytes]);
  }

  async upsertResidentIn(client:pg.PoolClient, collectionId:string, chunkId:string, storedBytes:number):Promise<void> {
    await client.query(`INSERT INTO files_chunk_cache(collection_id,chunk_id,state,stored_bytes,last_read_at)
      VALUES($1,$2,'resident',$3,NOW()) ON CONFLICT(collection_id,chunk_id) DO UPDATE
      SET state='resident',stored_bytes=EXCLUDED.stored_bytes,evicted_at=NULL,updated_at=NOW()`, [collectionId, chunkId, storedBytes]);
  }

  /** Rows left mid-eviction by a crash. */
  async interruptedEvictions():Promise<{ collection_id:string; chunk_id:string }[]> {
    return (await this.db.query("SELECT collection_id::text,chunk_id FROM files_chunk_cache WHERE state='evicting'")).rows;
  }

  /** Startup recovery: settle an interrupted eviction by whether the blob is still on disk. */
  async settleInterrupted(collectionId:string, chunkId:string, state:'resident' | 'evicted'):Promise<void> {
    await this.db.query("UPDATE files_chunk_cache SET state=$3,stored_bytes=CASE WHEN $3='evicted' THEN 0 ELSE stored_bytes END,updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2", [collectionId, chunkId, state]);
  }
}
