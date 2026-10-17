import type { Store } from './store.js';
import type pg from 'pg';

const STALE_UPLOAD_AGE = '1 hour';

export async function beginUploadIntent(db:pg.Pool, id:string, collectionId:string):Promise<void> {
  await db.query('INSERT INTO file_upload_intents(id,collection_id) VALUES($1,$2)', [id, collectionId]);
}

export async function publishUploadChunk(db:pg.Pool, uploadId:string, collectionId:string, chunkId:string, publish:()=>Promise<void>):Promise<void> {
  const updated = await db.query(`UPDATE file_upload_intents
    SET chunk_ids=CASE WHEN chunk_ids ? $2 THEN chunk_ids ELSE chunk_ids || to_jsonb($2::text) END,updated_at=NOW()
    WHERE id=$1 AND cleanup_started_at IS NULL`, [uploadId, chunkId]);
  if (updated.rowCount !== 1) throw new Error('Upload cleanup intent is unavailable');
  await publish();
}

export async function completeUploadIntent(db:pg.Pool, id:string):Promise<void> {
  await db.query('DELETE FROM file_upload_intents WHERE id=$1', [id]);
}

export async function cleanupStaleUploads(db:pg.Pool, store:Store):Promise<number> {
  // This is destructive only at service startup, before createApp().listen(),
  // keyring initialization, LocalFilesManager construction, or indexing. It
  // must not be scheduled while any Store publisher can be active.
  // Claim stale work durably before deleting blobs. A crashed cleanup remains
  // resumable, while a request that resumes after the deadline cannot publish.
  const stale = await db.query(`WITH candidates AS (
      SELECT id FROM file_upload_intents
      WHERE (cleanup_started_at IS NULL AND updated_at<NOW()-$1::interval) OR cleanup_started_at<NOW()-$1::interval
      ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 100
    ) UPDATE file_upload_intents intents SET cleanup_started_at=NOW() FROM candidates
      WHERE intents.id=candidates.id RETURNING intents.id,intents.collection_id,intents.chunk_ids`, [STALE_UPLOAD_AGE]);
  let cleaned = 0;
  for (const intent of stale.rows) {
    const chunkIds = Array.isArray(intent.chunk_ids) ? [...new Set(intent.chunk_ids.filter((id:unknown):id is string => typeof id === 'string'))] : [];
    for (const chunkId of chunkIds) {
      const state = (await db.query(`SELECT
        EXISTS(SELECT 1 FROM chunks WHERE collection_id=$1 AND id=$2) AS registered,
        EXISTS(SELECT 1 FROM file_upload_intents WHERE collection_id=$1 AND cleanup_started_at IS NULL AND updated_at>=NOW()-$3::interval AND chunk_ids ? $2) AS active`,
      [intent.collection_id, chunkId, STALE_UPLOAD_AGE])).rows[0];
      if (!state?.registered && !state?.active) await store.delete(intent.collection_id, chunkId);
    }
    await db.query('DELETE FROM file_upload_intents WHERE id=$1 AND cleanup_started_at IS NOT NULL', [intent.id]);
    cleaned++;
  }
  return cleaned;
}
