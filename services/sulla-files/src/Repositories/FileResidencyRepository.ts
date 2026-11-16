// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export type ResidencyRowState = 'local' | 'evicting' | 'online-only' | 'hydrating' | 'error';

export interface ResidencyStatusRow { desired_state: 'local' | 'online-only'; state: ResidencyRowState; last_error: string | null }
export interface PendingResidencyRow { file_id: string; state: ResidencyRowState; operation_id: string }

export interface CurrentVersionRow {
  file_id:             string;
  path:                string;
  current_version_id:  string;
  collection_id:       string;
  version_id:          string;
  chunk_collection_id: string;
  manifest_hash:       string;
  size:                string | number;
  total_size:          string | number;
  chunk_ids:           unknown;
}

export interface ChunkMetadataRow { id: string; size: string | number; stored_size: string | number }
export interface WatchedStateRow { content_hash: string; size: string | number; mtime_ms: string | number }
export interface RemoteProofRow { key_version: number; key_epoch: number; chunks_digest: string; chunks: unknown }
export interface ChunkHoldRow { unbacked_history: boolean; locally_required: boolean }

export interface RemoteProofInput {
  versionId:      string;
  collectionId:   string;
  manifestHash:   string;
  remoteRevision: string;
  chunksDigest:   string;
  keyVersion:     number;
  keyEpoch:       number;
  chunks:         { id: string; size: number; storedSize: number; ciphertextSha256: string }[];
}
export interface KeyRecoveryContext { collectionId: string; principalId: string; keyVersion: number; epoch: number }
export interface WatchedStateInput { collectionId: string; path: string; fileId: string; contentHash: string; size: number; mtimeMs: number }

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** Every read and write of per-file residency state, remote recovery proofs and watched-folder rows. */
export class FileResidencyRepository {
  constructor(private readonly db:Queryable) {}

  async findStatus(fileId:string):Promise<ResidencyStatusRow | undefined> {
    return (await this.db.query(
      `SELECT desired_state,state,last_error FROM file_residency WHERE file_id=$1`,
      [fileId],
    )).rows[0];
  }

  async listPending():Promise<PendingResidencyRow[]> {
    return (await this.db.query(
      `SELECT file_id,state,operation_id FROM file_residency
        WHERE state IN('evicting','hydrating') ORDER BY updated_at`,
    )).rows as PendingResidencyRow[];
  }

  /** The current, undeleted version of a file in the enabled default root, with its manifest. */
  async findCurrentVersion(fileId:string):Promise<CurrentVersionRow | undefined> {
    return (await this.db.query(
      `SELECT f.id AS file_id,f.path,f.current_version_id,f.collection_id,
              v.id AS version_id,v.chunk_collection_id,v.manifest_hash,v.size,
              m.total_size,m.chunk_ids
         FROM files f JOIN file_versions v ON v.id=f.current_version_id AND v.file_id=f.id
         JOIN manifests m ON m.hash=v.manifest_hash
        WHERE f.id=$1 AND f.deleted_at IS NULL AND NOT v.deleted
          AND f.collection_id=(SELECT collection_id FROM file_roots WHERE id='default' AND enabled=TRUE)`,
      [fileId],
    )).rows[0] as CurrentVersionRow | undefined;
  }

  async findChunkMetadata(chunkCollectionId:string, ids:string[]):Promise<ChunkMetadataRow[]> {
    return (await this.db.query(
      'SELECT id,size,stored_size FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])',
      [chunkCollectionId, ids],
    )).rows;
  }

  async findWatchedState(collectionId:string, fileId:string, path:string):Promise<WatchedStateRow | undefined> {
    return (await this.db.query(
      'SELECT content_hash,size,mtime_ms FROM watched_folder_state WHERE collection_id=$1 AND file_id=$2 AND path=$3',
      [collectionId, fileId, path],
    )).rows[0];
  }

  async begin(fileId:string, versionId:string, operationId:string, desired:'local' | 'online-only', state:'evicting' | 'hydrating'):Promise<void> {
    await this.db.query(
      `INSERT INTO file_residency(file_id,desired_state,state,version_id,operation_id,generation,last_error)
       VALUES($1,$2,$3,$4,$5,1,NULL)
       ON CONFLICT(file_id) DO UPDATE SET desired_state=EXCLUDED.desired_state,state=EXCLUDED.state,
         version_id=EXCLUDED.version_id,operation_id=EXCLUDED.operation_id,
         generation=file_residency.generation+1,last_error=NULL,updated_at=NOW()`,
      [fileId, desired, state, versionId, operationId],
    );
  }

  async isOperationCurrent(fileId:string, versionId:string, operationId:string, state:'evicting' | 'hydrating'):Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM files f JOIN file_residency r ON r.file_id=f.id
        WHERE f.id=$1 AND f.current_version_id=$2 AND r.version_id=$2 AND r.operation_id=$3 AND r.state=$4`,
      [fileId, versionId, operationId, state],
    );
    return result.rowCount === 1;
  }

  async recordFailure(fileId:string, operationId:string, keepPending:boolean, message:string):Promise<void> {
    await this.db.query(
      `UPDATE file_residency SET state=CASE WHEN $3 THEN state ELSE 'error' END,last_error=$4,updated_at=NOW()
        WHERE file_id=$1 AND operation_id=$2`,
      [fileId, operationId, keepPending, message],
    );
  }

  /** The stored remote proof for a version, regardless of the collection's current key. */
  async findRemoteProof(versionId:string, chunkCollectionId:string, manifestHash:string):Promise<RemoteProofRow | undefined> {
    return (await this.db.query(
      `SELECT p.key_version,p.key_epoch,p.chunks_digest,
              json_agg(json_build_object('id',c.chunk_id,'size',c.size,'storedSize',c.stored_size,
                'ciphertextSha256',c.ciphertext_sha256) ORDER BY c.ordinal) AS chunks
         FROM file_remote_version_proofs p JOIN file_remote_chunk_proofs c ON c.version_id=p.version_id
        WHERE p.version_id=$1 AND p.collection_id=$2 AND p.manifest_hash=$3
        GROUP BY p.key_version,p.key_epoch,p.chunks_digest`,
      [versionId, chunkCollectionId, manifestHash],
    )).rows[0];
  }

  /** The remote proof only when it was made under the collection's current recovery key. */
  async findRecoverableRemoteProof(versionId:string, chunkCollectionId:string, manifestHash:string):Promise<Pick<RemoteProofRow, 'chunks_digest' | 'chunks'> | undefined> {
    return (await this.db.query(
      `SELECT p.chunks_digest,
              json_agg(json_build_object('id',c.chunk_id,'size',c.size,'storedSize',c.stored_size,
                'ciphertextSha256',c.ciphertext_sha256) ORDER BY c.ordinal) AS chunks
         FROM file_remote_version_proofs p JOIN files_remote_key_recovery k ON k.collection_id=p.collection_id
         JOIN file_remote_chunk_proofs c ON c.version_id=p.version_id
        WHERE p.version_id=$1 AND p.collection_id=$2 AND p.manifest_hash=$3
          AND p.key_version=k.key_version AND p.key_epoch=k.key_epoch
        GROUP BY p.chunks_digest`,
      [versionId, chunkCollectionId, manifestHash],
    )).rows[0];
  }

  async isKeyRecoveryCurrent(context:KeyRecoveryContext):Promise<boolean> {
    const proof = await this.db.query(
      `SELECT 1 FROM files_remote_key_recovery WHERE collection_id=$1 AND principal_id=$2
        AND key_version=$3 AND key_epoch=$4`,
      [context.collectionId, context.principalId, context.keyVersion, context.epoch],
    );
    return proof.rowCount === 1;
  }

  /** Whether a cached chunk is still needed locally (unproven history or a non-online-only current file). */
  async findChunkHolds(chunkCollectionId:string, chunkId:string):Promise<ChunkHoldRow | undefined> {
    return (await this.db.query(
      `SELECT
        EXISTS(
          SELECT 1 FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
          LEFT JOIN file_remote_version_proofs p ON p.version_id=v.id
          WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2 AND p.version_id IS NULL
        ) AS unbacked_history,
        EXISTS(
          SELECT 1 FROM files f JOIN file_versions v ON v.id=f.current_version_id
          JOIN manifests m ON m.hash=v.manifest_hash
          LEFT JOIN file_residency r ON r.file_id=f.id
          WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2
            AND COALESCE(r.state,'local')<>'online-only'
        ) AS locally_required`,
      [chunkCollectionId, chunkId],
    )).rows[0];
  }

  // ── Transactional statements: `client` is the open transaction's client. ──

  /** Replaces the stored proof (version row upserted, chunk rows rewritten in ordinal order). */
  async saveRemoteProof(client:pg.PoolClient, proof:RemoteProofInput):Promise<void> {
    await client.query(
      `INSERT INTO file_remote_version_proofs
        (version_id,collection_id,manifest_hash,remote_revision,chunks_digest,key_version,key_epoch,verified_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT(version_id) DO UPDATE SET
         collection_id=EXCLUDED.collection_id,manifest_hash=EXCLUDED.manifest_hash,
         remote_revision=EXCLUDED.remote_revision,chunks_digest=EXCLUDED.chunks_digest,
         key_version=EXCLUDED.key_version,key_epoch=EXCLUDED.key_epoch,verified_at=EXCLUDED.verified_at`,
      [proof.versionId, proof.collectionId, proof.manifestHash, proof.remoteRevision,
        proof.chunksDigest, proof.keyVersion, proof.keyEpoch],
    );
    await client.query('DELETE FROM file_remote_chunk_proofs WHERE version_id=$1', [proof.versionId]);
    for (const [ordinal, chunk] of proof.chunks.entries()) {
      await client.query(
        `INSERT INTO file_remote_chunk_proofs(version_id,ordinal,chunk_id,size,stored_size,ciphertext_sha256)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [proof.versionId, ordinal, chunk.id, chunk.size, chunk.storedSize, chunk.ciphertextSha256],
      );
    }
  }

  /** Locks the file and residency rows; true only while this operation still owns the current version. */
  async lockOperation(client:pg.PoolClient, fileId:string, versionId:string, operationId:string, state:'evicting' | 'hydrating'):Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM files f JOIN file_residency r ON r.file_id=f.id
        WHERE f.id=$1 AND f.current_version_id=$2 AND r.version_id=$2 AND r.operation_id=$3 AND r.state=$4
        FOR UPDATE OF f,r`,
      [fileId, versionId, operationId, state],
    );
    return result.rowCount === 1;
  }

  async hasRemoteVersionProof(client:pg.PoolClient, versionId:string, chunkCollectionId:string, manifestHash:string):Promise<boolean> {
    const proof = await client.query('SELECT 1 FROM file_remote_version_proofs WHERE version_id=$1 AND collection_id=$2 AND manifest_hash=$3', [versionId, chunkCollectionId, manifestHash]);
    return proof.rowCount === 1;
  }

  async deleteWatchedState(client:pg.PoolClient, collectionId:string, fileId:string, path:string):Promise<void> {
    await client.query('DELETE FROM watched_folder_state WHERE collection_id=$1 AND file_id=$2 AND path=$3', [collectionId, fileId, path]);
  }

  async upsertWatchedState(client:pg.PoolClient, input:WatchedStateInput):Promise<void> {
    await client.query(
      `INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id)
       VALUES($1,$2,$3,$4,$5,$6,'default')
       ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,
         content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms`,
      [input.collectionId, input.path, input.fileId, input.contentHash, input.size, input.mtimeMs],
    );
  }

  async markOnlineOnly(client:pg.PoolClient, fileId:string):Promise<void> {
    await client.query("UPDATE file_residency SET state='online-only',desired_state='online-only',operation_id=NULL,last_error=NULL,updated_at=NOW() WHERE file_id=$1", [fileId]);
  }

  async markLocal(client:pg.PoolClient, fileId:string):Promise<void> {
    await client.query("UPDATE file_residency SET state='local',desired_state='local',operation_id=NULL,last_error=NULL,updated_at=NOW() WHERE file_id=$1", [fileId]);
  }
}
