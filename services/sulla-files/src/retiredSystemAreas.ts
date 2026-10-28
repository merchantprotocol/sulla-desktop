// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { drainPendingChunkGc } from './documentLifecycle.js';

import type pg from 'pg';

/** System areas Files no longer has. Migration 053 purged their files; this drops the empty collection rows. */
export const RETIRED_SYSTEM_AREAS = ['training-data'] as const;

const MAX_DRAIN_ROUNDS = 40;

type DeleteChunk = (collectionId:string, chunkId:string) => Promise<void>;

/**
 * Drops a retired system collection once nothing of it is left: no files (a retained file keeps
 * it), no pending chunk cleanup and no version elsewhere that reads its chunks. Its remaining
 * chunk blobs are deleted first, then the row (keys, ACL, chunk rows and the rest cascade).
 * Only rows of the named retired areas are ever touched. Safe to run on every start.
 */
export async function retireSystemAreas(db:pg.Pool, deleteChunk:DeleteChunk, log:(message:string)=>void = console.log):Promise<void> {
  for (const area of RETIRED_SYSTEM_AREAS) {
    const collection = (await db.query('SELECT id FROM collections WHERE system_area=$1', [area])).rows[0];
    if (!collection) continue;
    const id = String(collection.id);
    const pendingGc = async() => Number((await db.query('SELECT count(*)::int n FROM file_chunk_gc WHERE collection_id=$1', [id])).rows[0].n);
    for (let round = 0, before = await pendingGc(); before > 0 && round < MAX_DRAIN_ROUNDS; round++) {
      await drainPendingChunkGc(db, deleteChunk);
      const after = await pendingGc();
      if (after >= before) break; // failing deletes; retried on the next start
      before = after;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE file_versions IN SHARE ROW EXCLUSIVE MODE');
      const locked = (await client.query('SELECT id FROM collections WHERE id=$1 AND system_area=$2 FOR UPDATE', [id, area])).rows[0];
      const blockers = locked && (await client.query(`SELECT
          EXISTS(SELECT 1 FROM files WHERE collection_id=$1) files,
          EXISTS(SELECT 1 FROM file_chunk_gc WHERE collection_id=$1) gc,
          EXISTS(SELECT 1 FROM file_versions WHERE chunk_collection_id=$1) versions`, [id])).rows[0];
      if (!locked || blockers.files || blockers.gc || blockers.versions) {
        await client.query('ROLLBACK');
        if (locked) log(`[SullaFiles] retired ${ area } collection kept for now (files=${ blockers.files } pendingChunks=${ blockers.gc } versions=${ blockers.versions })`);
        continue;
      }
      const chunks = (await client.query('SELECT id FROM chunks WHERE collection_id=$1', [id])).rows;
      for (const chunk of chunks) await deleteChunk(id, String(chunk.id));
      // Rows that reference the collection without ON DELETE CASCADE.
      await client.query('DELETE FROM journal WHERE collection_id=$1', [id]);
      await client.query('DELETE FROM file_purge_tombstones WHERE collection_id=$1', [id]);
      await client.query('DELETE FROM file_share_links WHERE collection_id=$1', [id]);
      await client.query('DELETE FROM file_roots WHERE collection_id=$1', [id]);
      await client.query('DELETE FROM files_legacy_file_map WHERE source_collection_id=$1 OR shadow_collection_id=$1', [id]);
      await client.query('DELETE FROM files_legacy_collection_map WHERE source_collection_id=$1 OR shadow_collection_id=$1', [id]);
      await client.query('DELETE FROM collections WHERE id=$1 AND system_area=$2', [id, area]);
      await client.query('COMMIT');
      log(`[SullaFiles] removed the retired ${ area } collection (${ chunks.length } chunk blobs deleted)`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      log(`[SullaFiles] retired ${ area } collection cleanup paused: ${ error instanceof Error ? error.message : String(error) }`);
    } finally { client.release() }
  }
}

export function startRetiredSystemAreaCleanup(db:pg.Pool, deleteChunk:DeleteChunk):void {
  setTimeout(() => { void retireSystemAreas(db, deleteChunk) }, 10_000).unref?.();
}
