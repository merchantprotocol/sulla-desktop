// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { Config } from '../config.js';
import { TransactionRunner } from '../FilesTransaction.js';
import type { FilesKeyring } from '../keyring.js';
import type { CollectionRootKeyProvider } from '../cloudSync/keyStore.js';
import type { RestoreTarget } from '../cloudSync/restore.js';

/** Restore's local writes: a new Files collection with its own local keys, then the wrapped sync root. */
export class PgCloudRestoreTargetRepository implements RestoreTarget {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly keyring:FilesKeyring,
    private readonly roots:CollectionRootKeyProvider,
    private readonly transactions = new TransactionRunner(db),
  ) {}

  async localRoot(collectionId:string):Promise<{ keyVersion:number; root:Buffer | null } | null> {
    const row = (await this.db.query(`SELECT c.id,s.key_version,s.wrapped_root FROM collections c
      LEFT JOIN files_cloud_sync s ON s.collection_id=c.id WHERE c.id=$1`, [collectionId])).rows[0];
    if (!row) return null;
    if (!row.wrapped_root) return { keyVersion: Number(row.key_version ?? 1), root: null };
    return { keyVersion: Number(row.key_version), root: await this.roots.unwrap(collectionId, Number(row.key_version), row.wrapped_root) };
  }

  /** The collection row and its locally wrapped keys commit together or not at all. */
  async createCollection(collectionId:string, name:string):Promise<void> {
    const explorerPath = `${ name.replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Restored files' }--${ collectionId.slice(0, 8) }`;
    await this.transactions.run('cloud-restore-collection', async client => {
      await client.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,explorer_path)
        VALUES($1,$2,$3,$4,'knowledge','synced',$5,$6,'{}',$7)`, [collectionId, this.config.orgId ?? null, this.config.userId, name, {}, {}, explorerPath]);
      const wrapped = await this.keyring.create(collectionId, client);
      await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1', [collectionId, wrapped.data, wrapped.dedup]);
    });
  }

  async install(collectionId:string, keyVersion:number, root:Uint8Array, vaultId:string, vaultEpoch:number):Promise<void> {
    const wrapped = await this.roots.wrap(collectionId, keyVersion, root);
    await this.db.query(`INSERT INTO files_cloud_sync(collection_id,enabled,key_version,wrapped_root,status,cloud_created,escrow_vault_id,escrow_vault_epoch,last_seq,head)
      VALUES($1,TRUE,$2,$3,'idle',TRUE,$4,$5,0,NULL)
      ON CONFLICT(collection_id) DO UPDATE SET enabled=TRUE,key_version=EXCLUDED.key_version,wrapped_root=EXCLUDED.wrapped_root,status='idle',
        cloud_created=TRUE,escrow_vault_id=EXCLUDED.escrow_vault_id,escrow_vault_epoch=EXCLUDED.escrow_vault_epoch,last_error=NULL,updated_at=NOW()`,
    [collectionId, keyVersion, wrapped, vaultId, vaultEpoch]);
    await this.db.query("INSERT INTO file_sync_cursors(collection_id,device_id) VALUES($1,'cloud') ON CONFLICT DO NOTHING", [collectionId]);
  }
}
