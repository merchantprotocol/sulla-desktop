// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import { ChunkMetadataReconciler } from '../ChunkMetadataReconciler.js';
import type { Config } from '../config.js';
import { drainPendingChunkGc } from '../documentLifecycle.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { LocalFilesManager } from '../localManager.js';
import type { ScratchMaintenanceRepository } from '../Repositories/ScratchMaintenanceRepository.js';
import type { Store } from '../store.js';

/** Local-token maintenance: scratch expiry, disposal review, chunk GC and chunk metadata repair. */
export class LocalMaintenanceRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly transactions:TransactionRunner,
    private readonly maintenance:ScratchMaintenanceRepository,
    private readonly manager?:LocalFilesManager,
  ) {}

  register(app:express.Express):void {
    app.post('/v1/local/maintenance', async(_request, response, next) => { try { response.json(await this.runMaintenance()) } catch (error) { next(error) } });

    app.post('/v1/local/chunk-metadata/reconcile', async(request, response, next) => { try {
      if (!this.config.keyring) return response.status(503).json({ error:'Files keyring is unavailable' });
      const report = await new ChunkMetadataReconciler(this.db, this.store, this.config.keyring).run({ apply:request.body?.apply === true });
      response.json(report);
    } catch (error) { next(error) } });
  }

  private async runMaintenance() {
    const now = new Date();
    const { expired, disposal } = await this.transactions.run('maintenance-expiry', async client => {
      const disposal = await this.maintenance.markPendingDisposals(client);
      const expired = await this.maintenance.lockExpired(client, now);
      for (const file of expired) await this.maintenance.tombstone(client, file, now);
      return { expired, disposal };
    });
    await drainPendingChunkGc(this.db, (collectionId, chunkId) => this.store.delete(collectionId, chunkId));
    const chunkMetadataRepair = this.config.keyring
      ? await new ChunkMetadataReconciler(this.db, this.store, this.config.keyring).run({ apply:true })
      : undefined;
    const receiptGc = this.manager ? await this.manager.expireTrashReceipts(now) : { invalidated:0, disposed:0, preserved:0 };
    return { expiredFiles: expired.length, pendingDisposals: disposal.rowCount ?? disposal.rows.length, receiptGc, chunkMetadataRepair };
  }
}
