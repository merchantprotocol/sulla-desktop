// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SignedIncrementalManifest } from '../backup/incremental.js';
import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

export interface BackupSnapshotRow { id:string; manifest_key:string; verified_at:Date | null; restore_verified_at:Date | null; prune_manifest:SignedIncrementalManifest | null }
export interface NewBackupSnapshot { id:string; destinationId:string; tier:string; manifestKey:string; manifestSha256:string; createdAt:string }

/** Verified snapshots per destination, including the tombstone saved before a snapshot is pruned. */
export class BackupSnapshotRepository {
  /** Snapshots are only recorded after manifest and isolated-restore verification. */
  async insertVerified(client:Queryable, snapshot:NewBackupSnapshot):Promise<void> {
    await client.query(`INSERT INTO files_backup_snapshots(id,destination_id,tier,manifest_key,manifest_sha256,created_at,verified_at,restore_verified_at)
      VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())`, [snapshot.id, snapshot.destinationId, snapshot.tier, snapshot.manifestKey, snapshot.manifestSha256, snapshot.createdAt]);
  }

  async hasRestoreVerifiedSince(client:Queryable, destinationId:string, tier:string, since:Date):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM files_backup_snapshots WHERE destination_id=$1 AND tier=$2 AND created_at >= $3 AND restore_verified_at IS NOT NULL LIMIT 1', [destinationId, tier, since])).rowCount);
  }

  async listForDestination(client:Queryable, destinationId:string):Promise<BackupSnapshotRow[]> {
    return (await client.query('SELECT id,manifest_key,verified_at,restore_verified_at,prune_manifest FROM files_backup_snapshots WHERE destination_id=$1', [destinationId])).rows as BackupSnapshotRow[];
  }

  async markPruning(client:Queryable, snapshotId:string, manifest:SignedIncrementalManifest):Promise<void> {
    await client.query('UPDATE files_backup_snapshots SET prune_manifest=$2 WHERE id=$1', [snapshotId, manifest]);
  }

  async delete(client:Queryable, snapshotId:string):Promise<void> {
    await client.query('DELETE FROM files_backup_snapshots WHERE id=$1', [snapshotId]);
  }
}
