// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { CryptoModuleStatus } from './cryptoModule.js';

interface CatalogStatusRepository {
  finderBadges(collectionId:string):Promise<unknown>;
  statusRows():Promise<any[]>;
}

/** Read-only desktop status projection, separated from the CloudSync orchestration loop. */
export class CloudSyncDesktopStatus {
  constructor(private readonly cryptoModule:CryptoModuleStatus,private readonly catalog:CatalogStatusRepository) {}
  finderBadges(collectionId:string):Promise<unknown> { return this.catalog.finderBadges(collectionId) }
  async status() {
    const rows=await this.catalog.statusRows();
    return {cryptoModule:this.cryptoModule,collections:rows.map(row=>({
      collectionId:row.collection_id,name:row.name,enabled:Boolean(row.enabled),status:row.status,lastSyncAt:row.last_sync_at??null,
      pendingBytes:Number(row.pending_bytes),conflicts:Number(row.conflicts),lastError:row.last_error??null,
    }))};
  }
}
