// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface ClaimedUploadIntent { id:string; collection_id:string; chunk_ids:unknown }
export interface StaleChunkState { registered:boolean; active:boolean }

/**
 * Durable upload intents (file_upload_intents). An intent lists every chunk blob an
 * in-flight upload published, so a crashed upload's orphan blobs can be found and removed,
 * and a claimed (cleanup_started_at) intent can no longer publish.
 */
export class UploadIntentRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async begin(id:string, collectionId:string):Promise<void> {
    await this.db.query('INSERT INTO file_upload_intents(id,collection_id) VALUES($1,$2)', [id, collectionId]);
  }

  /** Records a chunk before its blob is published; false when the intent is gone or claimed by cleanup. */
  async addChunk(uploadId:string, chunkId:string):Promise<boolean> {
    const updated = await this.db.query(`UPDATE file_upload_intents
    SET chunk_ids=CASE WHEN chunk_ids ? $2 THEN chunk_ids ELSE chunk_ids || to_jsonb($2::text) END,updated_at=NOW()
    WHERE id=$1 AND cleanup_started_at IS NULL`, [uploadId, chunkId]);
    return updated.rowCount === 1;
  }

  async complete(id:string):Promise<void> {
    await this.db.query('DELETE FROM file_upload_intents WHERE id=$1', [id]);
  }

  /** Durably claims up to 100 stale intents (idle, or a cleanup that itself went stale). */
  async claimStale(staleAge:string):Promise<ClaimedUploadIntent[]> {
    return (await this.db.query(`WITH candidates AS (
      SELECT id FROM file_upload_intents
      WHERE (cleanup_started_at IS NULL AND updated_at<NOW()-$1::interval) OR cleanup_started_at<NOW()-$1::interval
      ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 100
    ) UPDATE file_upload_intents intents SET cleanup_started_at=NOW() FROM candidates
      WHERE intents.id=candidates.id RETURNING intents.id,intents.collection_id,intents.chunk_ids`, [staleAge])).rows;
  }

  /** Whether a chunk is registered in `chunks`, or still claimed by a live (unclaimed, fresh) upload. */
  async chunkState(collectionId:string, chunkId:string, staleAge:string):Promise<StaleChunkState | undefined> {
    return (await this.db.query(`SELECT
        EXISTS(SELECT 1 FROM chunks WHERE collection_id=$1 AND id=$2) AS registered,
        EXISTS(SELECT 1 FROM file_upload_intents WHERE collection_id=$1 AND cleanup_started_at IS NULL AND updated_at>=NOW()-$3::interval AND chunk_ids ? $2) AS active`,
    [collectionId, chunkId, staleAge])).rows[0];
  }

  /** Whether any version's manifest names the chunk (user content even when its `chunks` row is missing). */
  async referencedByVersion(collectionId:string, chunkId:string):Promise<boolean> {
    return Boolean((await this.db.query(`SELECT EXISTS(SELECT 1 FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
        WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2) AS referenced`, [collectionId, chunkId])).rows[0]?.referenced);
  }

  async deleteClaimed(id:string):Promise<void> {
    await this.db.query('DELETE FROM file_upload_intents WHERE id=$1 AND cleanup_started_at IS NOT NULL', [id]);
  }
}
