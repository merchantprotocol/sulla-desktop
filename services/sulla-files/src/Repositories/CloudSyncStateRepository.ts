// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import type pg from 'pg';

import { TransactionRunner } from '../FilesTransaction.js';
import type { Envelope } from '../crypto.js';
import type { SyncHead } from '../cloudSync/envelope.js';
import type { SyncRow, SyncStatus, UploadSession } from '../cloudSync/repository.js';

/** One collection's Cloud backup state (files_cloud_sync): enablement, escrow, head and the open upload session. */
export class PgCloudSyncStateRepository {
  constructor(private readonly db:pg.Pool, private readonly transactions = new TransactionRunner(db)) {}

  async sync(collectionId:string):Promise<SyncRow | null> {
    const row = (await this.db.query('SELECT * FROM files_cloud_sync WHERE collection_id=$1', [collectionId])).rows[0];
    return row ? PgCloudSyncStateRepository.syncRow(row) : null;
  }

  async enabledCollections():Promise<SyncRow[]> {
    return (await this.db.query("SELECT * FROM files_cloud_sync WHERE enabled=TRUE AND wrapped_root IS NOT NULL ORDER BY updated_at")).rows.map(PgCloudSyncStateRepository.syncRow);
  }

  /** First enable stores a new wrapped root; later enables keep the existing one. */
  async setEnabled(collectionId:string, enabled:boolean, wrappedRoot:Envelope | null):Promise<SyncRow> {
    return this.transactions.run('cloud-sync-metadata', async client => {
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
      return PgCloudSyncStateRepository.syncRow((await client.query('SELECT * FROM files_cloud_sync WHERE collection_id=$1', [collectionId])).rows[0]);
    });
  }

  async needsEscrow(vaultId:string, vaultEpoch:number):Promise<SyncRow[]> {
    return (await this.db.query(`SELECT * FROM files_cloud_sync WHERE enabled=TRUE AND wrapped_root IS NOT NULL
      AND (status='needs-vault' OR escrow_vault_id IS DISTINCT FROM $1 OR escrow_vault_epoch IS DISTINCT FROM $2)`, [vaultId, vaultEpoch])).rows.map(PgCloudSyncStateRepository.syncRow);
  }

  async setStatus(collectionId:string, status:SyncStatus, lastError:string | null = null):Promise<void> {
    await this.db.query('UPDATE files_cloud_sync SET status=$2,last_error=$3,updated_at=NOW() WHERE collection_id=$1 AND enabled=TRUE',
      [collectionId, status, lastError]);
  }

  /** The collection's folder name when Cloud doesn't hold this exact name yet (first backup or a rename). */
  async staleInfoName(collectionId:string):Promise<{ name:string; sha:string } | null> {
    const row = (await this.db.query(`SELECT c.name,s.info_name_sha FROM collections c JOIN files_cloud_sync s ON s.collection_id=c.id WHERE c.id=$1`, [collectionId])).rows[0];
    const name = typeof row?.name === 'string' ? row.name.trim().slice(0, 200) : '';
    if (!name) return null;
    const sha = createHash('sha256').update(name, 'utf8').digest('hex');
    return row.info_name_sha === sha ? null : { name, sha };
  }

  async markInfoSent(collectionId:string, nameSha:string):Promise<void> {
    await this.db.query('UPDATE files_cloud_sync SET info_name_sha=$2,updated_at=NOW() WHERE collection_id=$1', [collectionId, nameSha || null]);
  }

  async markCreated(collectionId:string, head:SyncHead, vaultId:string, vaultEpoch:number):Promise<void> {
    await this.db.query(`UPDATE files_cloud_sync SET cloud_created=TRUE,info_name_sha=NULL,last_seq=$2,head=$3,escrow_vault_id=$4,escrow_vault_epoch=$5,
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

  /** The cloud copy is gone: forget every head, version and chunk mapping, and rewind the cloud cursor. Local files stay. */
  async markCloudDeleted(collectionId:string):Promise<void> {
    await this.transactions.run('cloud-sync-metadata', async client => {
      await client.query(`UPDATE files_cloud_sync SET enabled=FALSE,status='off',wrapped_root=NULL,head=NULL,last_seq=0,cloud_created=FALSE,info_name_sha=NULL,
          escrow_vault_id=NULL,escrow_vault_epoch=NULL,upload_session=NULL,pending_bytes=0,last_error=NULL,updated_at=NOW() WHERE collection_id=$1`, [collectionId]);
      await client.query('DELETE FROM files_cloud_file_heads WHERE collection_id=$1', [collectionId]);
      await client.query('DELETE FROM files_cloud_versions WHERE collection_id=$1', [collectionId]);
      await client.query('DELETE FROM files_cloud_chunk_map WHERE collection_id=$1', [collectionId]);
      await client.query("UPDATE file_sync_cursors SET last_push_seq=0,last_seq=0 WHERE collection_id=$1 AND device_id='cloud'", [collectionId]);
    });
  }

  async saveSession(collectionId:string, session:UploadSession | null, pendingBytes:number, status:SyncStatus):Promise<void> {
    await this.db.query('UPDATE files_cloud_sync SET upload_session=$2,pending_bytes=$3,status=$4,updated_at=NOW() WHERE collection_id=$1',
      [collectionId, session, pendingBytes, status]);
  }

  async saveVerifiedHead(collectionId:string, head:SyncHead):Promise<void> {
    await this.db.query(`UPDATE files_cloud_sync SET last_seq=$2,head=$3,last_sync_at=NOW(),last_error=NULL,updated_at=NOW() WHERE collection_id=$1`,
      [collectionId, head.seq, head]);
  }

  private static syncRow(row:any):SyncRow {
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
}
