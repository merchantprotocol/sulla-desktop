// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ensureSyncSchema } from '../browserEnvelope/schema.js';
import type { Database } from '../db.js';

export interface FilesCloudEscrowSyncState { vault_id:string; epoch:number|string }

/** Cloud vault sync state reads for the Files Cloud escrow. SQL moved verbatim from filesCloudEscrow.ts (E9). */
export class PostgresFilesCloudEscrowRepository {
  constructor(private readonly db:Database) {}

  async ensureSchema():Promise<void> {
    await ensureSyncSchema(this.db);
  }

  /** Whether this desktop holds any Cloud vault sync state (rows[0]?.present, verbatim). */
  async cloudVaultConfigured():Promise<boolean|undefined> {
    return (await this.db.query<{present:boolean}>('SELECT EXISTS(SELECT 1 FROM cloud_vault_sync_state) AS present')).rows[0]?.present;
  }

  async findSyncState(userId:string):Promise<FilesCloudEscrowSyncState|undefined> {
    return (await this.db.query<FilesCloudEscrowSyncState>('SELECT vault_id,epoch FROM cloud_vault_sync_state WHERE owner_user_id=$1',[userId])).rows[0];
  }
}
