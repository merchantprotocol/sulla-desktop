// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface StreamVersionRow {
  id:string; path:string; mime:string | null; version_id:string; chunk_collection_id:string;
  size:string | number; total_size:string | number; chunk_ids:unknown;
}
export interface StreamChunkRow { id:string; size:string | number; stored_size:string | number }

/** What the content read path needs to stream one file version: its manifest and chunk sizes. */
export class FileStreamRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** The requested (or current) version of a file with its manifest; undefined when missing or deleted. */
  async version(fileId:string, versionId?:string):Promise<StreamVersionRow | undefined> {
    const result = await this.db.query(
      `SELECT f.id,f.path,f.mime,v.id AS version_id,v.chunk_collection_id,v.size,m.total_size,m.chunk_ids
       FROM files f
       JOIN file_versions v ON v.id=COALESCE($2::uuid,f.current_version_id) AND v.file_id=f.id
       JOIN manifests m ON m.hash=v.manifest_hash
      WHERE f.id=$1 AND NOT v.deleted`,
      [fileId, versionId ?? null],
    );
    return result.rows[0];
  }

  /** Recorded plaintext and stored sizes for the given chunk ids (absent rows are simply missing). */
  async chunkSizes(collectionId:string, ids:readonly string[]):Promise<StreamChunkRow[]> {
    return (await this.db.query('SELECT id,size,stored_size FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, ids])).rows;
  }
}
