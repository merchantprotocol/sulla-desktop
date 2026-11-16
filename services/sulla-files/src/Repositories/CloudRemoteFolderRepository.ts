// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import { TransactionRunner } from '../FilesTransaction.js';
import type { ApplyRemoteInput } from '../cloudSync/pull.js';
import { conflictPath } from '../cloudSync/validation.js';
import { assertStoredFolderPath, ensureStoredFileParents, lockStoredNamespace, StoredNamespaceConflict } from '../storedNamespace.js';
import type { PgCloudFileHeadRepository } from './CloudFileHeadRepository.js';

/**
 * Pull side for explicit encrypted folder identities (files_cloud_folders): create, move
 * (with its subtree) or delete the local folder a remote folder version describes.
 */
export class PgCloudRemoteFolderRepository {
  constructor(
    private readonly db:pg.Pool,
    private readonly actor:FilesIdentity,
    private readonly heads:Pick<PgCloudFileHeadRepository, 'upsert'>,
    private readonly transactions = new TransactionRunner(db),
  ) {}

  async applyRemoteFolderVersion(input:ApplyRemoteInput):Promise<void> {
    const { collectionId, remote, manifest } = input;
    await this.transactions.run('cloud-sync-metadata', async client => {
      await lockStoredNamespace(client, collectionId);
      await client.query("SELECT set_config('sulla_files.cloud_pull','on',TRUE)");
      const prior = (await client.query('SELECT path FROM files_cloud_folders WHERE collection_id=$1 AND file_id=$2 FOR UPDATE', [collectionId, remote.fileId])).rows[0];
      if (manifest.deleted) {
        // Delete only this stable identity. Descendants are independent encrypted items and remain visible.
        if (prior?.path) await client.query('UPDATE file_folders SET deleted_at=NOW(),namespace_parent_version_id=namespace_version_id,namespace_version_id=$4,updated_at=NOW() WHERE collection_id=$1 AND path=$2 AND id=$3', [collectionId,prior.path,remote.fileId,remote.versionId]);
      } else {
        const path = await this.freeFolderPath(client, collectionId, manifest.path, remote.fileId, input.remoteDeviceLabel, !prior?.path);
        if (prior?.path && prior.path !== path) {
          // Create only the destination's parents. Creating `path` itself first makes the
          // subtree move collide with file_folders(collection_id,path)'s unique key.
          await ensureStoredFileParents(client, collectionId, path, this.actor);
          await this.moveStoredSubtree(client, collectionId, prior.path, path);
        } else {
          await ensureStoredFileParents(client, collectionId, `${ path }/.folder`, this.actor);
        }
        const existing = (await client.query('SELECT id::text AS id FROM file_folders WHERE collection_id=$1 AND path=$2 FOR UPDATE', [collectionId, path])).rows[0];
        if (existing && existing.id !== remote.fileId) {
          // Parent synthesis has no Cloud identity. Adopt it rather than replacing the UUID.
          const claimed = (await client.query('SELECT 1 FROM files_cloud_folders WHERE collection_id=$1 AND file_id=$2 AND deleted=FALSE', [collectionId, existing.id])).rowCount;
          if (claimed) throw new StoredNamespaceConflict('A different folder identity already occupies the synchronized path');
          await client.query('UPDATE file_folders SET id=$3,namespace_parent_version_id=namespace_version_id,namespace_version_id=$4,deleted_at=NULL,updated_at=NOW() WHERE collection_id=$1 AND path=$2', [collectionId,path,remote.fileId,remote.versionId]);
        } else if (existing) {
          await client.query('UPDATE file_folders SET namespace_parent_version_id=namespace_version_id,namespace_version_id=$3,deleted_at=NULL,updated_at=NOW() WHERE id=$1 AND collection_id=$2', [remote.fileId,collectionId,remote.versionId]);
        } else if (!existing) {
          await client.query(`INSERT INTO file_folders(id,collection_id,path,created_by_type,created_by_id,namespace_version_id) VALUES($1,$2,$3,'user',$4,$5)`,
            [remote.fileId,collectionId,path,this.actor.userId,remote.versionId]);
        }
        await client.query(`INSERT INTO files_cloud_folders(collection_id,file_id,version_id,path,deleted) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(collection_id,file_id) DO UPDATE SET version_id=EXCLUDED.version_id,path=EXCLUDED.path,deleted=EXCLUDED.deleted,updated_at=NOW()`,
        [collectionId, remote.fileId, remote.versionId, path, false]);
      }
      if (manifest.deleted) {
        await client.query(`INSERT INTO files_cloud_folders(collection_id,file_id,version_id,path,deleted) VALUES($1,$2,$3,$4,TRUE)
          ON CONFLICT(collection_id,file_id) DO UPDATE SET version_id=EXCLUDED.version_id,path=COALESCE(EXCLUDED.path,files_cloud_folders.path),deleted=TRUE,updated_at=NOW()`,
        [collectionId, remote.fileId, remote.versionId, prior?.path ?? null]);
      }
      await this.heads.upsert(client, collectionId, remote.fileId, remote.versionId, manifest.deleted, remote.seq);
    });
  }

  async cloudFolderPath(collectionId:string, fileId:string):Promise<string | null> {
    const row = (await this.db.query('SELECT path FROM files_cloud_folders WHERE collection_id=$1 AND file_id=$2', [collectionId, fileId])).rows[0];
    return typeof row?.path === 'string' ? row.path : null;
  }

  private async freeFolderPath(client:pg.PoolClient, collectionId:string, wanted:string, sameFolderId:string, label:string, mayAdoptSynthetic:boolean):Promise<string> {
    for (const candidate of [wanted, conflictPath(wanted, label), conflictPath(wanted, `${ label }-2`)]) {
      try {
        await assertStoredFolderPath(client, collectionId, candidate);
        const occupant = (await client.query('SELECT id::text AS id FROM file_folders WHERE collection_id=$1 AND path=$2', [collectionId, candidate])).rows[0];
        if (!occupant || occupant.id === sameFolderId) return candidate;
        const claimed = (await client.query('SELECT 1 FROM files_cloud_folders WHERE collection_id=$1 AND file_id=$2 AND deleted=FALSE', [collectionId, occupant.id])).rowCount;
        if (!claimed && candidate === wanted && mayAdoptSynthetic) return candidate;
      } catch (error) {
        if (!(error instanceof StoredNamespaceConflict)) throw error;
      }
    }
    throw new StoredNamespaceConflict('No free path is available for a synced folder');
  }

  private async moveStoredSubtree(client:pg.PoolClient, collectionId:string, from:string, to:string):Promise<void> {
    const token = `.cloud-folder-move-${ randomUUID() }`;
    await client.query(`UPDATE file_folders SET path=$3||substring(path,length($2)+1),updated_at=NOW()
      WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))`, [collectionId, from, token]);
    await client.query(`UPDATE files SET path=$3||substring(path,length($2)+1),updated_at=NOW()
      WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))`, [collectionId, from, token]);
    await client.query(`UPDATE files_cloud_folders SET path=$3||substring(path,length($2)+1),updated_at=NOW()
      WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))`, [collectionId, from, token]);
    await client.query(`UPDATE file_folders SET path=$3||substring(path,length($2)+1),updated_at=NOW()
      WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))`, [collectionId, token, to]);
    await client.query(`UPDATE files SET path=$3||substring(path,length($2)+1),updated_at=NOW()
      WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))`, [collectionId, token, to]);
    await client.query(`UPDATE files_cloud_folders SET path=$3||substring(path,length($2)+1),updated_at=NOW()
      WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))`, [collectionId, token, to]);
  }
}
