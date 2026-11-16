// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VectorBackfillRepository } from '../Repositories/VectorBackfillRepository.js';
import { VECTOR_READY_MARKER } from '../Repositories/VectorStateRepository.js';

import type pg from 'pg';

const COPY_BATCH = 1_000;
const NULL_BATCH = 2_000;
const PAUSE_MS = 50;
const START_DELAY_MS = 30_000;
const LOCK_KEY = 4_511_045; // pg_try_advisory_lock key: one backfill at a time

export interface VectorBackfillOptions {
  log?:          (message:string) => void;
  pause?:        (ms:number) => Promise<void>;
  /** Builds the repository on the dedicated session; replaceable in tests. */
  repositoryFor?: (session:pg.PoolClient) => VectorBackfillRepository;
}

/**
 * Moves JSON embeddings into the halfvec table, builds the HNSW index, flips the
 * "ready" marker (search switches to halfvec) and finally drops the JSON copies.
 * Throttled and idempotent; safe to run on every boot until the marker exists.
 * Never throws: failures are logged and the next boot resumes.
 */
export class VectorBackfillService {
  private readonly log:           (message:string) => void;
  private readonly pause:         (ms:number) => Promise<void>;
  private readonly repositoryFor: (session:pg.PoolClient) => VectorBackfillRepository;

  constructor(private readonly db:Pick<pg.Pool, 'connect'>, options:VectorBackfillOptions = {}) {
    this.log = options.log ?? console.log;
    this.pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms).unref?.()));
    this.repositoryFor = options.repositoryFor ?? (session => new VectorBackfillRepository(session));
  }

  /** Starts the backfill shortly after startup; never awaited by the caller. */
  start():void {
    setTimeout(() => { void this.run() }, START_DELAY_MS).unref?.();
  }

  async run():Promise<void> {
    const lock = await this.db.connect();
    const backfill = this.repositoryFor(lock);
    try {
      if (!await backfill.tryLock(LOCK_KEY)) return;
      const status = await backfill.status(VECTOR_READY_MARKER);
      if (!status.has_table) return;
      if (!status.done && !await this.copyAndIndex(backfill)) return;
      let cleared = 0;
      for (;;) {
        const rows = await backfill.clearJsonBatch(NULL_BATCH);
        if (!rows) break;
        cleared += rows;
        await this.pause(PAUSE_MS);
      }
      if (cleared) this.log(`[FilesVector] dropped ${ cleared } JSON embedding copies`);
    } catch (error) {
      this.log(`[FilesVector] backfill paused: ${ error instanceof Error ? error.message : String(error) }`);
    } finally {
      await backfill.unlock(LOCK_KEY).catch(() => undefined);
      // Maintenance SETs must never escape into a request client.
      lock.release(true);
    }
  }

  /** Copies, indexes and marks ready. False when rows appeared during the build (next start finishes). */
  private async copyAndIndex(backfill:VectorBackfillRepository):Promise<boolean> {
    let copied = 0;
    for (;;) {
      const rows = await backfill.copyBatch(COPY_BATCH);
      if (!rows) break;
      copied += rows;
      if (copied % 20_000 < COPY_BATCH) this.log(`[FilesVector] copied ${ copied } embeddings`);
      await this.pause(PAUSE_MS);
    }
    this.log(`[FilesVector] copy complete (${ copied } rows); building HNSW index`);
    await backfill.buildIndex();
    // Rows indexed while the build ran carry both copies; anything still JSON-only gets one more pass.
    if (await backfill.hasJsonOnlyChunks()) { this.log('[FilesVector] new rows appeared during the index build; will finish on the next start'); return false }
    await backfill.markReady(VECTOR_READY_MARKER);
    this.log('[FilesVector] semantic search now uses halfvec + HNSW');
    return true;
  }
}
