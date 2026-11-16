// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import { TransactionRunner } from '../FilesTransaction.js';
import type { StateEntry } from '../cloudSync/envelope.js';
import type { RemoteVersion } from '../cloudSync/validation.js';

/**
 * What this device last saw as each file's Cloud head (files_cloud_file_heads). Commit
 * baseVersionId and both stateHash checks read it; a head only ever moves to a higher seq.
 */
export class PgCloudFileHeadRepository {
  /** Rows per keyset page when streaming the heads for a stateHash. */
  static readonly pageSize = 5000;

  constructor(private readonly db:pg.Pool, private readonly transactions = new TransactionRunner(db)) {}

  async cloudHead(collectionId:string, fileId:string):Promise<string | null> {
    const row = (await this.db.query('SELECT version_id::text AS version_id FROM files_cloud_file_heads WHERE collection_id=$1 AND file_id=$2', [collectionId, fileId])).rows[0];
    return row?.version_id ?? null;
  }

  /** Cloud heads in fileId order, pageSize rows per query (keyset on the primary key). */
  async *cloudHeadPages(collectionId:string):AsyncGenerator<StateEntry[], void, void> {
    const pageSize = PgCloudFileHeadRepository.pageSize;
    let after = '00000000-0000-0000-0000-000000000000'; let first = true;
    while (true) {
      const rows = (await this.db.query(`SELECT file_id::text AS file_id,version_id::text AS version_id,deleted FROM files_cloud_file_heads WHERE collection_id=$1 AND (file_id>$2::uuid OR $3) ORDER BY file_id LIMIT $4`,
        [collectionId, after, first, pageSize])).rows;
      if (rows.length) yield rows.map(row => ({ fileId: row.file_id, versionId: row.version_id, deleted: Boolean(row.deleted) }));
      if (rows.length < pageSize) return;
      after = rows.at(-1).file_id; first = false;
    }
  }

  /** Record a cloud head for a version that is already present locally (and mark that version as known to Cloud). */
  async recordCloudHead(collectionId:string, remote:RemoteVersion):Promise<void> {
    await this.transactions.run('cloud-sync-metadata', async client => {
      const local = (await client.query('SELECT file_id::text AS file_id FROM file_versions WHERE id=$1', [remote.versionId])).rows[0];
      if (local?.file_id === remote.fileId) {
        await client.query(`INSERT INTO files_cloud_versions(version_id,collection_id,file_id,pushed_seq) VALUES($1,$2,$3,$4)
          ON CONFLICT(version_id) DO UPDATE SET pushed_seq=EXCLUDED.pushed_seq`, [remote.versionId, collectionId, remote.fileId, remote.seq]);
      }
      await this.upsert(client, collectionId, remote.fileId, remote.versionId, remote.deleted, remote.seq);
    });
  }

  /** Inside the caller's transaction. An older seq never replaces a newer head. */
  async upsert(client:pg.PoolClient, collectionId:string, fileId:string, versionId:string, deleted:boolean, seq:number):Promise<void> {
    await client.query(`INSERT INTO files_cloud_file_heads(collection_id,file_id,version_id,deleted,seq) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(collection_id,file_id) DO UPDATE SET version_id=EXCLUDED.version_id,deleted=EXCLUDED.deleted,seq=EXCLUDED.seq,updated_at=NOW()
      WHERE files_cloud_file_heads.seq<=EXCLUDED.seq`, [collectionId, fileId, versionId, deleted, seq]);
  }
}
