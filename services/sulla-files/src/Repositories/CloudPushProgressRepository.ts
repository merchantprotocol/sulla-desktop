// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import { TransactionRunner } from '../FilesTransaction.js';
import type { SyncHead } from '../cloudSync/envelope.js';
import type { RecursiveDeleteProgress, RecursiveDeleteProgressStore } from '../cloudSync/push.js';
import type { UploadSession } from '../cloudSync/repository.js';
import type { PgCloudFileHeadRepository } from './CloudFileHeadRepository.js';

/**
 * How far the uploader got: the cloud push cursor (file_sync_cursors, device 'cloud'),
 * parked versions (files_cloud_skips), recursive-delete batch progress
 * (files_cloud_namespace_batches) and the bookkeeping of an acknowledged commit.
 */
export class PgCloudPushProgressRepository implements RecursiveDeleteProgressStore {
  constructor(
    private readonly db:pg.Pool,
    private readonly heads:Pick<PgCloudFileHeadRepository, 'upsert'>,
    private readonly transactions = new TransactionRunner(db),
  ) {}

  async pushCursor(collectionId:string):Promise<number> {
    const row = (await this.db.query("SELECT last_push_seq FROM file_sync_cursors WHERE collection_id=$1 AND device_id='cloud'", [collectionId])).rows[0];
    return Number(row?.last_push_seq ?? 0);
  }

  /** The cursor only moves forward. */
  async advancePushCursor(collectionId:string, journalSeq:number):Promise<void> {
    await this.db.query(`UPDATE file_sync_cursors SET last_push_seq=GREATEST(last_push_seq,$2) WHERE collection_id=$1 AND device_id='cloud'`, [collectionId, journalSeq]);
  }

  /** Parks a version that keeps failing backup; retried after 1h, 2h, 4h… up to a day. */
  async skipVersion(collectionId:string, fileId:string, versionId:string, error:string):Promise<void> {
    await this.db.query(`INSERT INTO files_cloud_skips(version_id,collection_id,file_id,error,retry_at)
      SELECT $1,$2,$3,$4,NOW()+INTERVAL '1 hour' WHERE EXISTS(SELECT 1 FROM file_versions WHERE id=$1)
      ON CONFLICT(version_id) DO UPDATE SET error=excluded.error,attempts=files_cloud_skips.attempts+1,skipped_at=NOW(),
        retry_at=NOW()+LEAST(INTERVAL '24 hours', INTERVAL '1 hour'*POWER(2,files_cloud_skips.attempts))`,
    [versionId, collectionId, fileId, error.slice(0, 500)]);
  }

  async clearSkip(versionId:string):Promise<void> {
    await this.db.query('DELETE FROM files_cloud_skips WHERE version_id=$1', [versionId]);
  }

  async load(rootItemId:string):Promise<RecursiveDeleteProgress|null> {
    const row=(await this.db.query(`SELECT batch_id::text,root_item_id::text,device_id,next_index,sessions FROM files_cloud_namespace_batches
      WHERE root_item_id=$1`,[rootItemId])).rows[0];
    return row?{batchId:row.batch_id,rootItemId:row.root_item_id,deviceId:row.device_id,nextIndex:Number(row.next_index),sessions:row.sessions}:null;
  }

  /** Progress never moves backwards, and only the batch and device that started it may advance it. */
  async save(progress:RecursiveDeleteProgress):Promise<void> {
    await this.db.query(`INSERT INTO files_cloud_namespace_batches(batch_id,collection_id,root_item_id,device_id,next_index,sessions)
      SELECT $1,collection_id,$2,$3,$4,$5 FROM (SELECT collection_id FROM files WHERE id=$2 UNION ALL SELECT collection_id FROM file_folders WHERE id=$2 LIMIT 1) root
      ON CONFLICT(collection_id,root_item_id) DO UPDATE SET next_index=GREATEST(files_cloud_namespace_batches.next_index,EXCLUDED.next_index),sessions=EXCLUDED.sessions,updated_at=NOW()
      WHERE files_cloud_namespace_batches.batch_id=EXCLUDED.batch_id AND files_cloud_namespace_batches.device_id=EXCLUDED.device_id`,
    [progress.batchId,progress.rootItemId,progress.deviceId,progress.nextIndex,progress.sessions]);
  }

  async clear(batchId:string):Promise<void> {
    await this.db.query('DELETE FROM files_cloud_namespace_batches WHERE batch_id=$1',[batchId]);
  }

  /** Cloud acknowledged the commit: record the version, its head, the cursor and the new collection head in one transaction. */
  async finishCommit(collectionId:string, session:UploadSession, head:SyncHead):Promise<void> {
    await this.transactions.run('cloud-sync-metadata', async client => {
      if (session.namespaceKind === 'folder') {
        await client.query(`INSERT INTO files_cloud_folder_versions(version_id,collection_id,folder_id,pushed_seq) VALUES($1,$2,$3,$4)
          ON CONFLICT(version_id) DO UPDATE SET pushed_seq=EXCLUDED.pushed_seq`, [session.versionId,collectionId,session.fileId,head.seq]);
      } else await client.query(`INSERT INTO files_cloud_versions(version_id,collection_id,file_id,pushed_seq) VALUES($1,$2,$3,$4)
        ON CONFLICT(version_id) DO UPDATE SET pushed_seq=EXCLUDED.pushed_seq`, [session.versionId, collectionId, session.fileId, head.seq]);
      await this.heads.upsert(client, collectionId, session.fileId, session.versionId, session.deleted, head.seq);
      await client.query(`UPDATE file_sync_cursors SET last_push_seq=GREATEST(last_push_seq,$2) WHERE collection_id=$1 AND device_id='cloud'`,
        [collectionId, session.journalSeq]);
      await client.query(`UPDATE files_cloud_sync SET last_seq=$2,head=$3,status='idle',last_error=NULL,last_sync_at=NOW(),pending_bytes=0,
          upload_session=NULL,updated_at=NOW() WHERE collection_id=$1`, [collectionId, head.seq, head]);
    });
  }
}
