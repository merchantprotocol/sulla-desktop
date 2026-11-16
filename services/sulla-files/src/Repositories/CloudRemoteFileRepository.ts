// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import { TransactionRunner } from '../FilesTransaction.js';
import type { ApplyRemoteInput, ForkLocalInput, LocalFileState } from '../cloudSync/pull.js';
import { conflictPath } from '../cloudSync/validation.js';
import { assertStoredFilePath, ensureStoredFileParents, lockStoredNamespace, StoredNamespaceConflict } from '../storedNamespace.js';
import type { PgCloudFileHeadRepository } from './CloudFileHeadRepository.js';

/**
 * Pull side for files: reads the local state a remote version lands on, applies remote
 * versions onto their original file id, and keeps a local edit as a conflicted copy.
 * Every write holds the collection's stored-namespace lock inside one transaction.
 */
export class PgCloudRemoteFileRepository {
  constructor(
    private readonly db:pg.Pool,
    private readonly actor:FilesIdentity,
    private readonly heads:Pick<PgCloudFileHeadRepository, 'upsert'>,
    private readonly transactions = new TransactionRunner(db),
  ) {}

  /** The version already exists locally (we pushed it, or applied it before). */
  async hasLocalVersion(versionId:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM file_versions WHERE id=$1', [versionId])).rowCount);
  }

  /** null for a first version, undefined when the version is unknown here. */
  async versionParent(versionId:string):Promise<string | null | undefined> {
    const row = (await this.db.query('SELECT parent_version_id::text AS parent FROM file_versions WHERE id=$1', [versionId])).rows[0];
    return row ? (row.parent ?? null) : undefined;
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
    await this.transactions.run('cloud-sync-metadata', async client => {
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
      await this.transactions.run('cloud-sync-metadata', client => this.applyRemote(client, input, input.remote.fileId, input.remote.versionId));
    } catch (error:any) {
      // A record-locked or retained file cannot take the remote version; keep it as a separate copy instead.
      if (error?.code !== '55000' || input.manifest.deleted) throw error;
      const copyFileId = randomUUID();
      const copyVersionId = randomUUID();
      await this.transactions.run('cloud-sync-metadata', async client => {
        const copy = { ...input, manifest: { ...input.manifest, path: conflictPath(input.manifest.path, input.remoteDeviceLabel) } };
        await this.applyRemote(client, copy, copyFileId, copyVersionId, 'conflict');
        await this.heads.upsert(client, input.collectionId, input.remote.fileId, input.remote.versionId, input.remote.deleted, input.remote.seq);
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
      await this.heads.upsert(client, collectionId, remote.fileId, remote.versionId, true, remote.seq);
      return;
    }

    const path = await this.freePath(client, collectionId, manifest.path, existing ? fileId : null, input.remoteDeviceLabel);
    await ensureStoredFileParents(client, collectionId, path, this.actor);
    const chunkIds = content?.chunkIds ?? [];
    const hash = PgCloudRemoteFileRepository.manifestHash(chunkIds, manifest.size);
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
      await this.heads.upsert(client, collectionId, fileId, versionId, false, remote.seq);
    }
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

  private static manifestHash(chunkIds:string[], size:number):string {
    return createHash('sha256').update(JSON.stringify({ ids: chunkIds, size })).digest('hex');
  }
}
