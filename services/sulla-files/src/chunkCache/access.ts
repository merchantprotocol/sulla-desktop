// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChunkCacheRepository } from '../Repositories/ChunkCacheRepository.js';
import type pg from 'pg';

export class ChunkAccessTracker {
  private readonly pending = new Map<string, { collectionId:string; chunkId:string }>();
  private timer?:NodeJS.Timeout;
  constructor(
    db:Pick<pg.Pool, 'query'>,
    private readonly flushMs = 1_000,
    private readonly maxPending = 1_000,
    private readonly cache = new ChunkCacheRepository(db),
  ) {}
  get pendingSize():number { return this.pending.size }
  record(collectionId:string, chunkId:string):void {
    const key = `${collectionId}:${chunkId}`;
    if (!this.pending.has(key) && this.pending.size >= this.maxPending) void this.flush().catch(() => undefined);
    if (this.pending.size < this.maxPending || this.pending.has(key)) this.pending.set(key, { collectionId, chunkId });
    this.timer ??= setTimeout(() => void this.flush().catch(() => undefined), this.flushMs);
    this.timer.unref();
  }
  async flush():Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const entries = [...this.pending.values()]; this.pending.clear();
    if (!entries.length) return;
    await this.cache.recordAccess(entries);
  }
  stop():Promise<void> { return this.flush() }
}
