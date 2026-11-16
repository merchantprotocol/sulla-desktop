// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/**
 * Local chunk ↔ cloud chunk (files_cloud_chunk_map) plus the local chunk facts the uploader
 * needs. verified_at is what eviction trusts: it is set only once Cloud proved it holds the bytes.
 */
export class PgCloudChunkMapRepository {
  constructor(private readonly db:pg.Pool) {}

  /** No chunk of this collection may be evicted on the strength of its cloud copy any more. */
  async stopEviction(collectionId:string):Promise<void> {
    await this.db.query('UPDATE files_cloud_chunk_map SET verified_at=NULL WHERE collection_id=$1', [collectionId]);
  }

  async evictedChunks(collectionId:string):Promise<string[]> {
    return (await this.db.query("SELECT chunk_id FROM files_chunk_cache WHERE collection_id=$1 AND state='evicted' ORDER BY chunk_id", [collectionId]))
      .rows.map(row => String(row.chunk_id));
  }

  async chunkSize(collectionId:string, chunkId:string):Promise<{ size:number; storedSize:number } | null> {
    const row = (await this.db.query('SELECT size,stored_size FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId, chunkId])).rows[0];
    return row ? { size: Number(row.size), storedSize: Number(row.stored_size) } : null;
  }

  /** A cloud copy we uploaded ourselves (or downloaded), so it needs no new seal. */
  async uploadedCopy(collectionId:string, localChunkId:string):Promise<{ cloudChunkId:string; cipherBytes:number; cipherSha256:string } | null> {
    const row = (await this.db.query(`SELECT cloud_chunk_id,cipher_bytes,cipher_sha256 FROM files_cloud_chunk_map
      WHERE collection_id=$1 AND local_chunk_id=$2 AND (uploaded_at IS NOT NULL OR verified_at IS NOT NULL)`, [collectionId, localChunkId])).rows[0];
    return row ? { cloudChunkId: row.cloud_chunk_id, cipherBytes: Number(row.cipher_bytes), cipherSha256: row.cipher_sha256 } : null;
  }

  async recordSealedChunk(collectionId:string, localChunkId:string, cloudChunkId:string, cipherSha256:string, cipherBytes:number):Promise<void> {
    await this.db.query(`INSERT INTO files_cloud_chunk_map(collection_id,local_chunk_id,cloud_chunk_id,cipher_sha256,cipher_bytes)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(collection_id,local_chunk_id) DO UPDATE SET cloud_chunk_id=EXCLUDED.cloud_chunk_id,
        cipher_sha256=EXCLUDED.cipher_sha256,cipher_bytes=EXCLUDED.cipher_bytes,uploaded_at=NULL,verified_at=NULL`,
    [collectionId, localChunkId, cloudChunkId, cipherSha256, cipherBytes]);
  }

  /** The server verified size and sha256 on PUT. */
  async markUploaded(collectionId:string, cloudChunkId:string):Promise<void> {
    await this.db.query('UPDATE files_cloud_chunk_map SET uploaded_at=NOW(),verified_at=NOW() WHERE collection_id=$1 AND cloud_chunk_id=$2', [collectionId, cloudChunkId]);
  }

  /** The server holds a copy we did not write; record its real bytes once we have checked them. */
  async adoptServerCopy(collectionId:string, cloudChunkId:string, cipherSha256:string, cipherBytes:number):Promise<void> {
    await this.db.query(`UPDATE files_cloud_chunk_map SET cipher_sha256=$3,cipher_bytes=$4,uploaded_at=NULL,verified_at=NOW()
      WHERE collection_id=$1 AND cloud_chunk_id=$2`, [collectionId, cloudChunkId, cipherSha256, cipherBytes]);
  }

  async forgetUpload(collectionId:string, cloudChunkIds:string[]):Promise<void> {
    await this.db.query('UPDATE files_cloud_chunk_map SET uploaded_at=NULL,verified_at=NULL WHERE collection_id=$1 AND cloud_chunk_id=ANY($2::text[])',
      [collectionId, cloudChunkIds]);
  }
}
