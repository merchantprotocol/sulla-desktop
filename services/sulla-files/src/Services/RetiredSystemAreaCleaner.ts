// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { TransactionRunner } from '../FilesTransaction.js';
import type pg from 'pg';
import type { RetiredAreaBlockers, RetiredSystemAreaRepository } from '../Repositories/RetiredSystemAreaRepository.js';

export type DeleteChunk = (collectionId:string, chunkId:string) => Promise<void>;
export type DrainChunkGc = () => Promise<void>;

type RetireOutcome = { kind:'gone' } | { kind:'kept'; blockers:RetiredAreaBlockers } | { kind:'removed'; chunks:number };

/**
 * Drops a retired system collection once nothing of it is left: no files (a retained file keeps
 * it), no pending chunk cleanup and no version elsewhere that reads its chunks. Its remaining
 * chunk blobs are deleted first, then the row (keys, ACL, chunk rows and the rest cascade).
 * Only rows of the named retired areas are ever touched. Safe to run on every start.
 */
export class RetiredSystemAreaCleaner {
  /** System areas Files no longer has. Migration 053 purged their files; this drops the empty collection rows. */
  static readonly retiredAreas:readonly string[] = Object.freeze(['training-data']);
  static readonly maxDrainRounds = 40;

  constructor(
    private readonly repository:RetiredSystemAreaRepository,
    private readonly transactions:TransactionRunner,
    private readonly deleteChunk:DeleteChunk,
    private readonly drainChunkGc:DrainChunkGc,
    private readonly log:(message:string) => void = console.log,
  ) {}

  async retire():Promise<void> {
    for (const area of RetiredSystemAreaCleaner.retiredAreas) {
      const id = await this.repository.findCollectionId(area);
      if (id === undefined) continue;
      await this.drainPendingChunks(id);
      try {
        const outcome = await this.transactions.run('retired-system-area', client => this.dropIfEmpty(client, id, area));
        if (outcome.kind === 'kept') {
          const { blockers } = outcome;
          this.log(`[SullaFiles] retired ${ area } collection kept for now (files=${ blockers.files } pendingChunks=${ blockers.gc } versions=${ blockers.versions })`);
        } else if (outcome.kind === 'removed') {
          this.log(`[SullaFiles] removed the retired ${ area } collection (${ outcome.chunks } chunk blobs deleted)`);
        }
      } catch (error) {
        this.log(`[SullaFiles] retired ${ area } collection cleanup paused: ${ error instanceof Error ? error.message : String(error) }`);
      }
    }
  }

  /** Runs `retire` once, ten seconds after start, without holding the process open. */
  schedule(delayMs = 10_000):void {
    setTimeout(() => { void this.retire() }, delayMs).unref?.();
  }

  private async drainPendingChunks(id:string):Promise<void> {
    for (let round = 0, before = await this.repository.pendingChunkGc(id); before > 0 && round < RetiredSystemAreaCleaner.maxDrainRounds; round++) {
      await this.drainChunkGc();
      const after = await this.repository.pendingChunkGc(id);
      if (after >= before) break; // failing deletes; retried on the next start
      before = after;
    }
  }

  private async dropIfEmpty(client:pg.PoolClient, id:string, area:string):Promise<RetireOutcome> {
    await this.repository.lockVersions(client);
    if (!await this.repository.lockCollection(client, id, area)) return { kind: 'gone' };
    const blockers = await this.repository.blockers(client, id);
    if (blockers.files || blockers.gc || blockers.versions) return { kind: 'kept', blockers };
    const chunks = await this.repository.chunkIds(client, id);
    for (const chunk of chunks) await this.deleteChunk(id, chunk);
    await this.repository.deleteCollection(client, id, area);
    return { kind: 'removed', chunks: chunks.length };
  }
}
