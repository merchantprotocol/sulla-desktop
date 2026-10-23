import { createHash, randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import { assertStoredFilePath, ensureStoredFileParents, lockStoredNamespace, StoredNamespaceConflict } from '../storedNamespace.js';
import type { Envelope } from '../crypto.js';
import type { StateEntry, SyncHead } from './envelope.js';
import type { ApplyRemoteInput, ForkLocalInput, LocalFileState, PullRepository } from './pull.js';
import { conflictPath, type RemoteVersion } from './validation.js';

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'error' | 'needs-vault';
export type CloudOp = 'create' | 'escrow' | 'upload-open' | 'commit' | 'delete';

export interface UploadSession {
  journalSeq:number;
  fileId:string;
  versionId:string;
  parentVersionId:string | null;
  baseVersionId:string | null;
  deleted:boolean;
  manifest:unknown;
  /** Cloud chunk ids in file order (duplicates kept). */
  chunkIds:string[];
  declared:Array<{ id:string; cipherBytes:number; cipherSha256:string }>;
  /** Cloud ids sealed for this session and waiting in the staging directory. */
  staged:string[];
  uploadId:string | null;
  /** Declared chunks the server already held when the upload opened. */
  present:string[];
}

export interface SyncRow {
  collectionId:string;
  enabled:boolean;
  keyVersion:number;
  wrappedRoot:Envelope | null;
  lastSeq:number;
  head:SyncHead | null;
  status:SyncStatus;
  cloudCreated:boolean;
  escrowVaultId:string | null;
  escrowVaultEpoch:number | null;
  uploadSession:UploadSession | null;
}

export interface QueuedOperation {
  handle:string;
  collectionId:string;
  op:CloudOp;
  path:string;
  method:string;
  body:string | null;
  sha256:string;
  meta:Record<string, unknown>;
  attempts:number;
}

export interface PushCandidate {
  journalSeq:number;
  fileId:string;
  path:string;
  mime:string;
  versionId:string;
  parentVersionId:string | null;
  deleted:boolean;
  chunkCollectionId:string;
  chunkIds:string[];
  size:number;
  mtime:string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function syncRow(row:any):SyncRow {
  return {
    collectionId: String(row.collection_id),
    enabled: Boolean(row.enabled),
    keyVersion: Number(row.key_version),
    wrappedRoot: row.wrapped_root ?? null,
    lastSeq: Number(row.last_seq ?? 0),
    head: row.head ?? null,
    status: row.status,
    cloudCreated: Boolean(row.cloud_created),
    escrowVaultId: row.escrow_vault_id ?? null,
    escrowVaultEpoch: row.escrow_vault_epoch === null || row.escrow_vault_epoch === undefined ? null : Number(row.escrow_vault_epoch),
    uploadSession: row.upload_session ?? null,
  };
}

function manifestHash(chunkIds:string[], size:number):string {
  return createHash('sha256').update(JSON.stringify({ ids: chunkIds, size })).digest('hex');
}

async function transaction<T>(db:pg.Pool, work:(client:pg.PoolClient) => Promise<T>):Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** All cloud-sync SQL. Collections in system areas (Logs, Training Data) are never sync candidates. */
export class PgCloudSyncRepository implements PullRepository {
  constructor(private readonly db:pg.Pool, private readonly actor:FilesIdentity) {}

  // ---- collections and sync state ----

  async statusRows():Promise<any[]> {
    return (await this.db.query(`SELECT c.id::text AS collection_id,c.name,s.enabled,COALESCE(s.status,'off') AS status,s.last_sync_at,
        COALESCE(s.pending_bytes,0) AS pending_bytes,COALESCE(s.conflicts,0) AS conflicts,s.last_error
      FROM collections c LEFT JOIN files_cloud_sync s ON s.collection_id=c.id
      WHERE c.published=TRUE AND c.legacy_source=FALSE AND (c.system_area IS NULL OR c.system_area NOT IN ('logs','training-data'))
      ORDER BY c.name,c.id`)).rows;
  }

  async backupCandidate(collectionId:string):Promise<boolean> {
    if (!UUID.test(collectionId)) return false;
    return Boolean((await this.db.query(`SELECT 1 FROM collections WHERE id=$1 AND published=TRUE AND legacy_source=FALSE
      AND (system_area IS NULL OR system_area NOT IN ('logs','training-data'))`, [collectionId])).rowCount);
  }

  async localCollectionIds(ids:string[]):Promise<Set<string>> {
    const valid = ids.filter(id => UUID.test(id));
    if (!valid.length) return new Set();
    const rows = (await this.db.query('SELECT id::text AS id FROM collections WHERE id=ANY($1::uuid[])', [valid])).rows;
    return new Set(rows.map(row => String(row.id)));
  }

  async sync(collectionId:string):Promise<SyncRow | null> {
    const row = (await this.db.query('SELECT * FROM files_cloud_sync WHERE collection_id=$1', [collectionId])).rows[0];
    return row ? syncRow(row) : null;
  }

  async enabledCollections():Promise<SyncRow[]> {
    return (await this.db.query("SELECT * FROM files_cloud_sync WHERE enabled=TRUE AND wrapped_root IS NOT NULL ORDER BY updated_at")).rows.map(syncRow);
  }

  /** First enable stores a new wrapped root; later enables keep the existing one. */
  async setEnabled(collectionId:string, enabled:boolean, wrappedRoot:Envelope | null):Promise<SyncRow> {
    return transaction(this.db, async client => {
      const existing = (await client.query('SELECT * FROM files_cloud_sync WHERE collection_id=$1 FOR UPDATE', [collectionId])).rows[0];
      if (!existing) {
        await client.query(`INSERT INTO files_cloud_sync(collection_id,enabled,key_version,wrapped_root,status)
          VALUES($1,$2,1,$3,$4)`, [collectionId, enabled, wrappedRoot, enabled ? 'needs-vault' : 'off']);
      } else {
        const resumed = existing.cloud_created && existing.escrow_vault_id ? 'idle' : 'needs-vault';
        await client.query(`UPDATE files_cloud_sync SET enabled=$2,wrapped_root=COALESCE(wrapped_root,$3),status=$4,last_error=NULL,updated_at=NOW()
          WHERE collection_id=$1`, [collectionId, enabled, wrappedRoot, enabled ? resumed : 'off']);
      }
      await client.query("INSERT INTO file_sync_cursors(collection_id,device_id) VALUES($1,'cloud') ON CONFLICT DO NOTHING", [collectionId]);
      return syncRow((await client.query('SELECT * FROM files_cloud_sync WHERE collection_id=$1', [collectionId])).rows[0]);
    });
  }

  async needsEscrow(vaultId:string, vaultEpoch:number):Promise<SyncRow[]> {
    return (await this.db.query(`SELECT * FROM files_cloud_sync WHERE enabled=TRUE AND wrapped_root IS NOT NULL
      AND (status='needs-vault' OR escrow_vault_id IS DISTINCT FROM $1 OR escrow_vault_epoch IS DISTINCT FROM $2)`, [vaultId, vaultEpoch])).rows.map(syncRow);
  }

  async setStatus(collectionId:string, status:SyncStatus, lastError:string | null = null):Promise<void> {
    await this.db.query('UPDATE files_cloud_sync SET status=$2,last_error=$3,updated_at=NOW() WHERE collection_id=$1 AND enabled=TRUE',
      [collectionId, status, lastError]);
  }

  async markCreated(collectionId:string, head:SyncHead, vaultId:string, vaultEpoch:number):Promise<void> {
    await this.db.query(`UPDATE files_cloud_sync SET cloud_created=TRUE,last_seq=$2,head=$3,escrow_vault_id=$4,escrow_vault_epoch=$5,
        status='idle',last_error=NULL,last_sync_at=NOW(),updated_at=NOW() WHERE collection_id=$1`,
    [collectionId, head.seq, head, vaultId, vaultEpoch]);
  }

  /** The collection already exists in Cloud under this root; adopt it and let the next pull catch up from seq 0. */
  async adoptExisting(collectionId:string, vaultId:string, vaultEpoch:number):Promise<void> {
    await this.db.query(`UPDATE files_cloud_sync SET cloud_created=TRUE,last_seq=0,head=NULL,escrow_vault_id=$2,escrow_vault_epoch=$3,
        status='idle',last_error=NULL,updated_at=NOW() WHERE collection_id=$1`, [collectionId, vaultId, vaultEpoch]);
  }

  async markEscrowed(collectionId:string, vaultId:string, vaultEpoch:number):Promise<void> {
    await this.db.query(`UPDATE files_cloud_sync SET escrow_vault_id=$2,escrow_vault_epoch=$3,status=CASE WHEN status='needs-vault' THEN 'idle' ELSE status END,
        last_error=NULL,updated_at=NOW() WHERE collection_id=$1`, [collectionId, vaultId, vaultEpoch]);
  }

  /** No chunk of this collection may be evicted on the strength of its cloud copy any more. */
  async stopEviction(collectionId:string):Promise<void> {
    await this.db.query('UPDATE files_cloud_chunk_map SET verified_at=NULL WHERE collection_id=$1', [collectionId]);
  }

  async evictedChunks(collectionId:string):Promise<string[]> {
    return (await this.db.query("SELECT chunk_id FROM files_chunk_cache WHERE collection_id=$1 AND state='evicted' ORDER BY chunk_id", [collectionId]))
      .rows.map(row => String(row.chunk_id));
  }

  async markCloudDeleted(collectionId:string):Promise<void> {
    await transaction(this.db, async client => {
      await client.query(`UPDATE files_cloud_sync SET enabled=FALSE,status='off',wrapped_root=NULL,head=NULL,last_seq=0,cloud_created=FALSE,
          escrow_vault_id=NULL,escrow_vault_epoch=NULL,upload_session=NULL,pending_bytes=0,last_error=NULL,updated_at=NOW() WHERE collection_id=$1`, [collectionId]);
      await client.query('DELETE FROM files_cloud_file_heads WHERE collection_id=$1', [collectionId]);
      await client.query('DELETE FROM files_cloud_versions WHERE collection_id=$1', [collectionId]);
      await client.query('DELETE FROM files_cloud_chunk_map WHERE collection_id=$1', [collectionId]);
      await client.query("UPDATE file_sync_cursors SET last_push_seq=0,last_seq=0 WHERE collection_id=$1 AND device_id='cloud'", [collectionId]);
    });
  }

  // ---- signed operation queue ----

  async queue(collectionId:string, op:CloudOp, path:string, method:string, body:string | null, sha256:string, handle:string, meta:Record<string, unknown> = {}):Promise<void> {
    await this.db.query(`INSERT INTO files_cloud_operations(handle,collection_id,op,path,method,body,sha256,meta)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [handle, collectionId, op, path, method, body, sha256, meta]);
  }

  async nextOperation():Promise<QueuedOperation | null> {
    const row = (await this.db.query(`SELECT o.* FROM files_cloud_operations o JOIN files_cloud_sync s ON s.collection_id=o.collection_id
      WHERE s.enabled=TRUE OR o.op='delete' ORDER BY o.created_at,o.handle LIMIT 1`)).rows[0];
    return row ? this.operation(row) : null;
  }

  async hasOperation(collectionId:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM files_cloud_operations WHERE collection_id=$1 LIMIT 1', [collectionId])).rowCount);
  }

  async operationByHandle(handle:string):Promise<QueuedOperation | null> {
    if (!UUID.test(handle)) return null;
    const row = (await this.db.query('SELECT * FROM files_cloud_operations WHERE handle=$1', [handle])).rows[0];
    return row ? this.operation(row) : null;
  }

  private operation(row:any):QueuedOperation {
    return {
      handle: String(row.handle),
      collectionId: String(row.collection_id),
      op: row.op,
      path: row.path,
      method: row.method,
      body: row.body ?? null,
      sha256: row.sha256,
      meta: row.meta ?? {},
      attempts: Number(row.attempts ?? 0),
    };
  }

  async completeOperation(handle:string):Promise<void> {
    await this.db.query('DELETE FROM files_cloud_operations WHERE handle=$1', [handle]);
  }

  async failOperation(handle:string, error:string):Promise<number> {
    const row = (await this.db.query('UPDATE files_cloud_operations SET attempts=attempts+1,last_error=$2 WHERE handle=$1 RETURNING attempts', [handle, error])).rows[0];
    return Number(row?.attempts ?? 0);
  }

  async dropCollectionOperations(collectionId:string, ops:CloudOp[]):Promise<void> {
    await this.db.query('DELETE FROM files_cloud_operations WHERE collection_id=$1 AND op=ANY($2::text[])', [collectionId, ops]);
  }

  // ---- push side ----

  async pushCursor(collectionId:string):Promise<number> {
    const row = (await this.db.query("SELECT last_push_seq FROM file_sync_cursors WHERE collection_id=$1 AND device_id='cloud'", [collectionId])).rows[0];
    return Number(row?.last_push_seq ?? 0);
  }

  /** The earliest journal entry whose version is still its file's current version and is unknown to Cloud. */
  async nextPushCandidate(collectionId:string, cursor:number):Promise<PushCandidate | null> {
    const row = (await this.db.query(`SELECT j.seq,f.id::text AS file_id,f.path,f.mime,v.id::text AS version_id,v.parent_version_id::text AS parent_version_id,
        v.deleted,v.chunk_collection_id::text AS chunk_collection_id,v.size,v.created_at,m.chunk_ids,w.mtime_ms
      FROM journal j
      JOIN files f ON f.id=j.file_id AND f.current_version_id=j.version_id
      JOIN file_versions v ON v.id=j.version_id
      LEFT JOIN manifests m ON m.hash=v.manifest_hash
      LEFT JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
      WHERE j.collection_id=$1 AND j.seq>$2
        AND NOT EXISTS(SELECT 1 FROM files_cloud_versions cv WHERE cv.version_id=v.id)
      ORDER BY j.seq LIMIT 1`, [collectionId, cursor])).rows[0];
    if (!row) return null;
    const mtime = row.mtime_ms !== null && row.mtime_ms !== undefined ? new Date(Number(row.mtime_ms)) : new Date(row.created_at);
    return {
      journalSeq: Number(row.seq),
      fileId: row.file_id,
      path: row.path,
      mime: row.mime,
      versionId: row.version_id,
      parentVersionId: row.parent_version_id ?? null,
      deleted: Boolean(row.deleted),
      chunkCollectionId: row.chunk_collection_id,
      chunkIds: row.deleted ? [] : (row.chunk_ids ?? []),
      size: row.deleted ? 0 : Number(row.size),
      mtime: mtime.toISOString(),
    };
  }

  async advancePushCursor(collectionId:string, journalSeq:number):Promise<void> {
    await this.db.query(`UPDATE file_sync_cursors SET last_push_seq=GREATEST(last_push_seq,$2) WHERE collection_id=$1 AND device_id='cloud'`, [collectionId, journalSeq]);
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

  async saveSession(collectionId:string, session:UploadSession | null, pendingBytes:number, status:SyncStatus):Promise<void> {
    await this.db.query('UPDATE files_cloud_sync SET upload_session=$2,pending_bytes=$3,status=$4,updated_at=NOW() WHERE collection_id=$1',
      [collectionId, session, pendingBytes, status]);
  }

  async finishCommit(collectionId:string, session:UploadSession, head:SyncHead):Promise<void> {
    await transaction(this.db, async client => {
      await client.query(`INSERT INTO files_cloud_versions(version_id,collection_id,file_id,pushed_seq) VALUES($1,$2,$3,$4)
        ON CONFLICT(version_id) DO UPDATE SET pushed_seq=EXCLUDED.pushed_seq`, [session.versionId, collectionId, session.fileId, head.seq]);
      await this.upsertCloudHead(client, collectionId, session.fileId, session.versionId, session.deleted, head.seq);
      await client.query(`UPDATE file_sync_cursors SET last_push_seq=GREATEST(last_push_seq,$2) WHERE collection_id=$1 AND device_id='cloud'`,
        [collectionId, session.journalSeq]);
      await client.query(`UPDATE files_cloud_sync SET last_seq=$2,head=$3,status='idle',last_error=NULL,last_sync_at=NOW(),pending_bytes=0,
          upload_session=NULL,updated_at=NOW() WHERE collection_id=$1`, [collectionId, head.seq, head]);
    });
  }

  async cloudHead(collectionId:string, fileId:string):Promise<string | null> {
    const row = (await this.db.query('SELECT version_id::text AS version_id FROM files_cloud_file_heads WHERE collection_id=$1 AND file_id=$2', [collectionId, fileId])).rows[0];
    return row?.version_id ?? null;
  }

  // ---- PullRepository ----

  async cloudHeads(collectionId:string):Promise<StateEntry[]> {
    return (await this.db.query(`SELECT file_id::text AS file_id,version_id::text AS version_id,deleted FROM files_cloud_file_heads WHERE collection_id=$1`,
      [collectionId])).rows.map(row => ({ fileId: row.file_id, versionId: row.version_id, deleted: Boolean(row.deleted) }));
  }

  async hasLocalVersion(versionId:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM file_versions WHERE id=$1', [versionId])).rowCount);
  }

  async isCloudVersion(versionId:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM files_cloud_versions WHERE version_id=$1', [versionId])).rowCount);
  }

  async localFile(collectionId:string, fileId:string):Promise<LocalFileState | null> {
    const row = (await this.db.query(`SELECT f.path,f.current_version_id::text AS current_version_id,COALESCE(v.deleted,FALSE) AS deleted,f.collection_id::text AS collection_id
      FROM files f LEFT JOIN file_versions v ON v.id=f.current_version_id WHERE f.id=$1`, [fileId])).rows[0];
    if (!row) return null;
    if (row.collection_id !== collectionId) throw Object.assign(new Error('Cloud file id belongs to another local collection'), { code: 'FILES_SYNC_INTEGRITY' });
    return { path: row.path, currentVersionId: row.current_version_id ?? null, deleted: Boolean(row.deleted) };
  }

  async forkLocalVersion(input:ForkLocalInput):Promise<void> {
    await transaction(this.db, async client => {
      await lockStoredNamespace(client, input.collectionId);
      const source = (await client.query(`SELECT f.mime,f.size AS file_size,v.chunk_collection_id::text AS chunk_collection_id,v.manifest_hash,v.size,
          v.created_by_type,v.created_by_id,m.chunk_ids
        FROM files f JOIN file_versions v ON v.id=$2 AND v.file_id=f.id LEFT JOIN manifests m ON m.hash=v.manifest_hash
        WHERE f.id=$1 AND f.collection_id=$3 FOR UPDATE OF f`, [input.fileId, input.versionId, input.collectionId])).rows[0];
      if (!source) throw new Error('Local version to preserve is missing');
      const path = await this.freePath(client, input.collectionId, input.path, null);
      await ensureStoredFileParents(client, input.collectionId, path, this.actor);
      await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [input.newFileId, input.collectionId, path, source.created_by_type, source.created_by_id, source.mime, source.size]);
      await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id)
        VALUES($1,$2,$3,NULL,$4,$5,FALSE,$6,$7,$8,$9)`,
      [input.newVersionId, input.newFileId, source.chunk_collection_id, source.manifest_hash, source.size, source.created_by_type, source.created_by_id,
        'Conflicted copy kept by Sulla Cloud backup', this.actor.deviceId]);
      await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [input.newFileId, input.newVersionId]);
      const chunkIds:string[] = source.chunk_ids ?? [];
      if (chunkIds.length) {
        await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [source.chunk_collection_id, chunkIds]);
      }
      await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'conflict')", [input.collectionId, input.newFileId, input.newVersionId]);
      await client.query('UPDATE files_cloud_sync SET conflicts=conflicts+1,updated_at=NOW() WHERE collection_id=$1', [input.collectionId]);
    });
  }

  async applyRemoteVersion(input:ApplyRemoteInput):Promise<void> {
    try {
      await transaction(this.db, client => this.applyRemote(client, input, input.remote.fileId, input.remote.versionId));
    } catch (error:any) {
      // A record-locked or retained file cannot take the remote version; keep it as a separate copy instead.
      if (error?.code !== '55000' || input.manifest.deleted) throw error;
      const copyFileId = randomUUID();
      const copyVersionId = randomUUID();
      await transaction(this.db, async client => {
        const copy = { ...input, manifest: { ...input.manifest, path: conflictPath(input.manifest.path, input.remoteDeviceLabel) } };
        await this.applyRemote(client, copy, copyFileId, copyVersionId, 'conflict');
        await this.upsertCloudHead(client, input.collectionId, input.remote.fileId, input.remote.versionId, input.remote.deleted, input.remote.seq);
        await client.query('UPDATE files_cloud_sync SET conflicts=conflicts+1,updated_at=NOW() WHERE collection_id=$1', [input.collectionId]);
      });
    }
  }

  private async applyRemote(client:pg.PoolClient, input:ApplyRemoteInput, fileId:string, versionId:string, journalOp?:'conflict'):Promise<void> {
    const { collectionId, remote, manifest, content } = input;
    await lockStoredNamespace(client, collectionId);
    const existing = (await client.query('SELECT id,collection_id::text AS collection_id,current_version_id::text AS current_version_id FROM files WHERE id=$1 FOR UPDATE',
      [fileId])).rows[0];
    if (existing && existing.collection_id !== collectionId) throw Object.assign(new Error('Cloud file id belongs to another local collection'), { code: 'FILES_SYNC_INTEGRITY' });
    const parent = await this.localParent(client, fileId, remote.parentVersionId, existing?.current_version_id ?? null);
    const deviceId = (remote.deviceId ?? 'cloud').slice(0, 128);
    const tracked = journalOp !== 'conflict';

    if (manifest.deleted) {
      if (existing) {
        await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id)
          VALUES($1,$2,$3,$4,NULL,0,TRUE,'user',$5,$6,$7)`, [versionId, fileId, collectionId, parent, this.actor.userId, 'Deleted on another device (Sulla Cloud)', deviceId]);
        await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [fileId, versionId]);
        await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [collectionId, fileId, versionId]);
        await client.query(`INSERT INTO files_cloud_versions(version_id,collection_id,file_id,pushed_seq) VALUES($1,$2,$3,$4) ON CONFLICT(version_id) DO NOTHING`,
          [versionId, collectionId, fileId, remote.seq]);
      }
      await this.upsertCloudHead(client, collectionId, remote.fileId, remote.versionId, true, remote.seq);
      return;
    }

    const path = await this.freePath(client, collectionId, manifest.path, existing ? fileId : null, input.remoteDeviceLabel);
    await ensureStoredFileParents(client, collectionId, path, this.actor);
    const chunkIds = content?.chunkIds ?? [];
    const hash = manifestHash(chunkIds, manifest.size);
    await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [hash, JSON.stringify(chunkIds), manifest.size]);
    for (const chunk of content?.chunks ?? []) {
      await client.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING',
        [collectionId, chunk.id, chunk.size, chunk.storedSize, `chunks/${ collectionId }/${ chunk.id }`]);
    }
    if (existing) {
      await client.query(`UPDATE files SET path=$2,mime=$3,size=$4,deleted_at=NULL,extracted_at=NULL,extraction_status='pending',updated_at=NOW() WHERE id=$1`,
        [fileId, path, manifest.mime, manifest.size]);
    } else {
      await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,$3,'user',$4,$5,$6)`,
        [fileId, collectionId, path, this.actor.userId, manifest.mime, manifest.size]);
    }
    await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id)
      VALUES($1,$2,$3,$4,$5,$6,FALSE,'user',$7,$8,$9)`,
    [versionId, fileId, collectionId, tracked ? parent : null, hash, manifest.size, this.actor.userId,
      tracked ? 'Changed on another device (Sulla Cloud)' : 'Conflicted copy kept by Sulla Cloud backup', deviceId]);
    await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    if (chunkIds.length) await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [collectionId, chunkIds]);
    await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [collectionId, fileId, versionId, journalOp ?? 'put']);
    if (tracked) {
      await client.query(`INSERT INTO files_cloud_versions(version_id,collection_id,file_id,pushed_seq) VALUES($1,$2,$3,$4) ON CONFLICT(version_id) DO NOTHING`,
        [versionId, collectionId, fileId, remote.seq]);
      await this.upsertCloudHead(client, collectionId, fileId, versionId, false, remote.seq);
    }
  }

  async recordCloudHead(collectionId:string, remote:RemoteVersion):Promise<void> {
    await transaction(this.db, async client => {
      const local = (await client.query('SELECT file_id::text AS file_id FROM file_versions WHERE id=$1', [remote.versionId])).rows[0];
      if (local?.file_id === remote.fileId) {
        await client.query(`INSERT INTO files_cloud_versions(version_id,collection_id,file_id,pushed_seq) VALUES($1,$2,$3,$4)
          ON CONFLICT(version_id) DO UPDATE SET pushed_seq=EXCLUDED.pushed_seq`, [remote.versionId, collectionId, remote.fileId, remote.seq]);
      }
      await this.upsertCloudHead(client, collectionId, remote.fileId, remote.versionId, remote.deleted, remote.seq);
    });
  }

  async saveVerifiedHead(collectionId:string, head:SyncHead):Promise<void> {
    await this.db.query(`UPDATE files_cloud_sync SET last_seq=$2,head=$3,last_sync_at=NOW(),last_error=NULL,updated_at=NOW() WHERE collection_id=$1`,
      [collectionId, head.seq, head]);
  }

  private async upsertCloudHead(client:pg.PoolClient, collectionId:string, fileId:string, versionId:string, deleted:boolean, seq:number):Promise<void> {
    await client.query(`INSERT INTO files_cloud_file_heads(collection_id,file_id,version_id,deleted,seq) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(collection_id,file_id) DO UPDATE SET version_id=EXCLUDED.version_id,deleted=EXCLUDED.deleted,seq=EXCLUDED.seq,updated_at=NOW()
      WHERE files_cloud_file_heads.seq<=EXCLUDED.seq`, [collectionId, fileId, versionId, deleted, seq]);
  }

  private async localParent(client:pg.PoolClient, fileId:string, remoteParent:string | null, current:string | null):Promise<string | null> {
    if (remoteParent) {
      const found = (await client.query('SELECT 1 FROM file_versions WHERE id=$1 AND file_id=$2', [remoteParent, fileId])).rowCount;
      if (found) return remoteParent;
    }
    return current;
  }

  /** The wanted path, or a conflicted-copy name beside it when another local file or folder already holds it. */
  private async freePath(client:pg.PoolClient, collectionId:string, wanted:string, sameFileId:string | null, label = 'cloud'):Promise<string> {
    const candidates = [wanted, conflictPath(wanted, label), conflictPath(wanted, `${ label }-2`)];
    for (const candidate of candidates) {
      try {
        await assertStoredFilePath(client, collectionId, candidate, sameFileId ?? undefined);
        return candidate;
      } catch (error) {
        if (!(error instanceof StoredNamespaceConflict)) throw error;
      }
    }
    throw new StoredNamespaceConflict('No free path is available for a synced file');
  }
}
