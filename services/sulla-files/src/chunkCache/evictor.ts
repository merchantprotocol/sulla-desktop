// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { stat } from 'node:fs/promises';
import { ChunkCacheBudget } from './budget.js';
import type { CloudChunkSource } from './types.js';
import type { Store } from '../store.js';
import type { ChunkCacheRepository } from '../Repositories/ChunkCacheRepository.js';

const RECENT_READ_MS = 5 * 60 * 1_000;

/**
 * Frees local chunk blobs that have a verified cloud copy, oldest-read first, until the
 * budget is met. Every guard is re-checked right before the blob is deleted: cloud copy
 * re-verified, not protected, collection not pinned, not read in the last 5 minutes.
 */
export class ChunkCacheEvictor {
  private running?:Promise<number>;
  constructor(
    private readonly cache:ChunkCacheRepository,
    private readonly store:Store,
    private readonly root:string,
    private readonly source:CloudChunkSource,
    private readonly budget = new ChunkCacheBudget(),
  ) {}
  run(requiredBytes?:number):Promise<number> { return this.running ??= this.evict(requiredBytes).finally(() => { this.running = undefined }); }
  private async evict(requiredBytes?:number):Promise<number> {
    const resident = await this.cache.residentBytes();
    let needed:number;
    try { needed = requiredBytes ?? await this.budget.requiredEvictionBytes(this.root, resident) } catch { return 0 }
    if (needed <= 0) return 0;
    const rows = await this.cache.evictionCandidates();
    let freed = 0;
    for (const row of rows) {
      if (freed >= needed) break;
      const collectionId = String(row.collection_id), id = String(row.chunk_id);
      const copy = await this.source.verifiedCopy(collectionId, id);
      if (!copy || !Number.isFinite(new Date(copy.verifiedAt).getTime())) continue;
      // Pinning is owned by cloud sync. Missing schema or row is fail-closed.
      try {
        const collection = await this.cache.collectionPin(collectionId);
        if (!collection || collection.keep_on_computer) continue;
      } catch { continue }
      if (!await this.source.reverify(collectionId, id)) continue;
      const [protectedNow, pinNow] = await Promise.all([
        this.cache.isProtected(collectionId, id),
        this.cache.collectionPin(collectionId),
      ]);
      if (protectedNow || !pinNow || pinNow.keep_on_computer) continue;
      const recent = await this.cache.lastReadAt(collectionId, id);
      if (recent && Date.now() - new Date(recent).getTime() < RECENT_READ_MS) continue;
      if (!await this.cache.beginEviction(collectionId, id)) continue;
      try {
        // Store.path constrains deletion to the configured encrypted chunk root.
        const info = await stat(this.store.path(collectionId, id));
        await this.store.delete(collectionId, id);
        await this.cache.completeEviction(collectionId, id);
        freed += info.size;
      } catch (error:any) {
        if (error?.code === 'ENOENT') await this.cache.markEvicted(collectionId, id);
        else { await this.cache.restoreResident(collectionId, id); throw error }
      }
    }
    return freed;
  }
}
