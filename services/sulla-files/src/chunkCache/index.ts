// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChunkAccessTracker } from './access.js';
import { ChunkCacheEvictor } from './evictor.js';
import { ChunkHydrator } from './hydrator.js';
import { Store } from '../store.js';
import { ChunkCacheRepository } from '../Repositories/ChunkCacheRepository.js';
import type { FilesKeyring } from '../keyring.js';
import type { CloudChunkSource } from './types.js';
import type pg from 'pg';

export interface ChunkCacheOptions { db:pg.Pool; root:string; keyring:FilesKeyring; source?:CloudChunkSource; intervalMs?:number }

export class CachingStore extends Store {
  private readonly access:ChunkAccessTracker;
  private readonly hydrator:ChunkHydrator;
  private readonly evictor:ChunkCacheEvictor;
  private readonly cache:ChunkCacheRepository;
  private timer?:NodeJS.Timeout;
  private lastWriteEviction = 0;
  constructor(private readonly options:ChunkCacheOptions) {
    super(options.root);
    this.cache = new ChunkCacheRepository(options.db);
    this.access = new ChunkAccessTracker(options.db, undefined, undefined, this.cache);
    this.hydrator = new ChunkHydrator(this.cache, this, options.keyring, options.source!);
    this.evictor = new ChunkCacheEvictor(this.cache, this, options.root, options.source!);
  }
  async start():Promise<void> {
    await this.recover();
    this.timer = setInterval(() => void this.evictor.run().catch(() => undefined), this.options.intervalMs ?? 60_000);
    this.timer.unref();
    void this.evictor.run().catch(() => undefined);
  }
  async recover():Promise<void> {
    for (const row of await this.cache.interruptedEvictions()) {
      const state = await super.has(row.collection_id, row.chunk_id) ? 'resident' : 'evicted';
      await this.cache.settleInterrupted(row.collection_id, row.chunk_id, state);
    }
  }
  override async get(collectionId:string, id:string):Promise<Buffer> {
    let value:Buffer;
    try { value = await super.get(collectionId, id) } catch (error:any) {
      if (error?.code !== 'ENOENT') throw error;
      value = await this.hydrator.hydrate(collectionId, id);
    }
    this.access.record(collectionId, id); return value;
  }
  override async getBounded(collectionId:string, id:string, maxBytes:number, expectedBytes:number):Promise<Buffer> {
    try {
      const value = await super.getBounded(collectionId, id, maxBytes, expectedBytes);
      this.access.record(collectionId, id); return value;
    } catch (error:any) {
      if (error?.code !== 'ENOENT') throw error;
      await this.hydrator.hydrate(collectionId, id);
      const value = await super.getBounded(collectionId, id, maxBytes, expectedBytes);
      this.access.record(collectionId, id); return value;
    }
  }
  override async put(collectionId:string, id:string, bytes:Uint8Array):Promise<boolean> {
    const created = await super.put(collectionId, id, bytes);
    await this.cache.upsertResident(collectionId, id, bytes.byteLength);
    // The eviction pass sums the whole cache table, so running it on every write made each
    // write O(cached chunks). The 60s timer still bounds the cache; writes only nudge it at most every 30s.
    if (Date.now() - this.lastWriteEviction >= 30_000) {
      this.lastWriteEviction = Date.now();
      void this.evictor.run().catch(() => undefined);
    }
    return created;
  }
  override async recordResident(client:pg.PoolClient, collectionId:string, id:string, storedBytes:number):Promise<void> {
    await this.cache.upsertResidentIn(client, collectionId, id, storedBytes);
  }
  override async putStaged(collectionId:string, id:string, bytes:Uint8Array):Promise<boolean> { return super.put(collectionId, id, bytes) }
  async stop():Promise<void> { if (this.timer) clearInterval(this.timer); await this.access.stop() }
}

export function createChunkStore(options:ChunkCacheOptions):Store {
  return options.source ? new CachingStore(options) : new Store(options.root);
}
export type { CloudChunkSource } from './types.js';
