// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SearchCleanupRepository } from '../Repositories/SearchCleanupRepository.js';

import type pg from 'pg';

const BATCH_SIZE = 1_000;
const PAUSE_MS = 50;
const LOCK_KEY = 8_795_143;
const START_DELAY_MS = 5_000;

export interface SearchCleanupOptions {
  log?:           (message:string) => void;
  pause?:         (ms:number) => Promise<void>;
  repositoryFor?: (session:pg.PoolClient) => SearchCleanupRepository;
}

/** Removes obsolete derived search rows in small, resumable batches. Never throws. */
export class SearchCleanupService {
  private readonly log:           (message:string) => void;
  private readonly pause:         (ms:number) => Promise<void>;
  private readonly repositoryFor: (session:pg.PoolClient) => SearchCleanupRepository;

  constructor(private readonly db:Pick<pg.Pool, 'connect'>, options:SearchCleanupOptions = {}) {
    this.log = options.log ?? console.log;
    this.pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms).unref?.()));
    this.repositoryFor = options.repositoryFor ?? (session => new SearchCleanupRepository(session));
  }

  start():void {
    setTimeout(() => { void this.run() }, START_DELAY_MS).unref?.();
  }

  async run():Promise<void> {
    const lock = await this.db.connect();
    const cleanup = this.repositoryFor(lock);
    try {
      if (!await cleanup.tryLock(LOCK_KEY)) return;
      let total = 0;
      const deletes = [
        (batch:number) => cleanup.deleteObsoleteChunks(batch),
        (batch:number) => cleanup.deleteLogsSearchText(batch),
        (batch:number) => cleanup.deleteObsoleteJobs(batch),
      ];
      for (const remove of deletes) for (;;) {
        const rows = await remove(BATCH_SIZE); if (!rows) break;
        total += rows; await this.pause(PAUSE_MS);
      }
      this.log(`[FilesSearchCleanup] complete (${ total } derived rows removed)`);
    } catch (error) {
      this.log(`[FilesSearchCleanup] paused: ${ error instanceof Error ? error.message : String(error) }`);
    } finally {
      await cleanup.unlock(LOCK_KEY).catch(() => undefined); lock.release();
    }
  }
}
