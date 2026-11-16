// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { Envelope } from '../crypto.js';

/** A verified cloud copy plus what is needed to open it (the collection's wrapped root and the local plaintext size). */
export interface MappedCloudChunk {
  cloudChunkId:string;
  cipherSha256:string;
  cipherBytes:number;
  keyVersion:number;
  wrappedRoot:Envelope;
  plainBytes:number | null;
}

/**
 * Local chunk ↔ cloud chunk (files_cloud_chunk_map) plus the local chunk facts the uploader
 * needs. verified_at is what eviction trusts: it is set only once Cloud proved it holds the bytes.
 */
export class PgCloudChunkMapRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

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

  // ---- P4 eviction / hydration (FilesCloudChunkSource) ----

  async verifiedCopy(collectionId:string, localChunkId:string):Promise<{ cloudChunkId:string; cipherSha256:string; cipherBytes:number; verifiedAt:Date } | null> {
    const row = (await this.db.query(`SELECT cloud_chunk_id,cipher_sha256,cipher_bytes,verified_at
      FROM files_cloud_chunk_map WHERE collection_id=$1 AND local_chunk_id=$2 AND verified_at IS NOT NULL`, [collectionId, localChunkId])).rows[0];
    if (!row) return null;
    return {
      cloudChunkId: String(row.cloud_chunk_id),
      cipherSha256: String(row.cipher_sha256),
      cipherBytes: Number(row.cipher_bytes),
      verifiedAt: new Date(row.verified_at),
    };
  }

  /** Only refresh rows that are still trusted; a cleared row (cloud copy being deleted) stays cleared. */
  async refreshVerified(collectionId:string, localChunkId:string):Promise<void> {
    await this.db.query('UPDATE files_cloud_chunk_map SET verified_at=NOW() WHERE collection_id=$1 AND local_chunk_id=$2 AND verified_at IS NOT NULL', [collectionId, localChunkId]);
  }

  async clearVerified(collectionId:string, localChunkId:string):Promise<void> {
    await this.db.query('UPDATE files_cloud_chunk_map SET verified_at=NULL WHERE collection_id=$1 AND local_chunk_id=$2', [collectionId, localChunkId]);
  }

  async mappedCopy(collectionId:string, localChunkId:string):Promise<MappedCloudChunk | null> {
    const row = (await this.db.query(`SELECT m.cloud_chunk_id,m.cipher_sha256,m.cipher_bytes,s.key_version,s.wrapped_root,c.size
      FROM files_cloud_chunk_map m
      JOIN files_cloud_sync s ON s.collection_id=m.collection_id
      LEFT JOIN chunks c ON c.collection_id=m.collection_id AND c.id=m.local_chunk_id
      WHERE m.collection_id=$1 AND m.local_chunk_id=$2 AND s.wrapped_root IS NOT NULL`, [collectionId, localChunkId])).rows[0];
    if (!row) return null;
    return {
      cloudChunkId: String(row.cloud_chunk_id),
      cipherSha256: String(row.cipher_sha256),
      cipherBytes: Number(row.cipher_bytes),
      keyVersion: Number(row.key_version),
      wrappedRoot: row.wrapped_root,
      plainBytes: row.size === null || row.size === undefined ? null : Number(row.size),
    };
  }

  // ---- pull materialization (CloudRemoteContent) ----

  /** The local chunk already holding this cloud chunk, if any. */
  async localCopyOf(collectionId:string, cloudChunkId:string):Promise<{ localChunkId:string; storedSize:number } | null> {
    const mapped = (await this.db.query(`SELECT m.local_chunk_id,c.stored_size FROM files_cloud_chunk_map m
      JOIN chunks c ON c.collection_id=m.collection_id AND c.id=m.local_chunk_id
      WHERE m.collection_id=$1 AND m.cloud_chunk_id=$2`, [collectionId, cloudChunkId])).rows[0];
    return mapped ? { localChunkId: mapped.local_chunk_id, storedSize: Number(mapped.stored_size) } : null;
  }

  /** A chunk downloaded from Cloud: its bytes came from the server, so it is verified (evictable) right away. */
  async recordDownloadedCopy(collectionId:string, localChunkId:string, cloudChunkId:string, cipherSha256:string, cipherBytes:number):Promise<void> {
    await this.db.query(`INSERT INTO files_cloud_chunk_map(collection_id,local_chunk_id,cloud_chunk_id,cipher_sha256,cipher_bytes,uploaded_at,verified_at)
      VALUES($1,$2,$3,$4,$5,NULL,NOW())
      ON CONFLICT(collection_id,local_chunk_id) DO UPDATE SET cloud_chunk_id=EXCLUDED.cloud_chunk_id,cipher_sha256=EXCLUDED.cipher_sha256,
        cipher_bytes=EXCLUDED.cipher_bytes,verified_at=NOW()`,
    [collectionId, localChunkId, cloudChunkId, cipherSha256, cipherBytes]);
  }
}
