// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** A scoped chunk upload intent issued by version prepare. */
export interface ChunkUploadIntent { file_id:string; target_collection_id:string; file_path:string; plain_size:string; version_id:string }

/** Who may read or write one stored chunk: protected chunks, referencing versions and scoped upload intents. */
export class ChunkAccessRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async isProtected(collectionId:string, chunkId:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM files_protected_chunks WHERE collection_id=$1 AND chunk_id=$2', [collectionId, chunkId])).rowCount);
  }

  /** Every file version whose manifest references this deduplicated chunk. */
  async referencingFiles(collectionId:string, chunkId:string):Promise<any[]> {
    return (await this.db.query(`SELECT DISTINCT f.*,v.id version_id,v.publication_status FROM file_versions v JOIN files f ON f.id=v.file_id JOIN manifests m ON m.hash=v.manifest_hash
      WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2`, [collectionId, chunkId])).rows;
  }

  /** This principal scope's unexpired upload intents for the chunk, latest expiry first. */
  async uploadIntents(collectionId:string, chunkId:string, principalId:string, actorScope:string):Promise<ChunkUploadIntent[]> {
    return (await this.db.query(`SELECT file_id::text,target_collection_id::text,file_path,plain_size,version_id::text FROM file_share_chunk_uploads
      WHERE chunk_collection_id=$1 AND chunk_id=$2 AND principal_id=$3 AND actor_scope=$4 AND expires_at>NOW() ORDER BY expires_at DESC`, [collectionId, chunkId, principalId, actorScope])).rows;
  }

  async markUploaded(versionIds:string[] | undefined, chunkId:string, principalId:string, actorScope:string):Promise<void> {
    await this.db.query('UPDATE file_share_chunk_uploads SET uploaded_at=NOW() WHERE version_id=ANY($1::uuid[]) AND chunk_id=$2 AND principal_id=$3 AND actor_scope=$4', [versionIds, chunkId, principalId, actorScope]);
  }
}
