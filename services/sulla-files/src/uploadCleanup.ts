// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { UploadIntentRepository } from './Repositories/UploadIntentRepository.js';

import type { Store } from './store.js';
import type pg from 'pg';

const STALE_UPLOAD_AGE = '1 hour';

/** An upload's lifecycle: begin an intent, record each chunk before publishing its blob, complete. */
export class UploadIntentService {
  constructor(private readonly intents:UploadIntentRepository) {}

  begin(id:string, collectionId:string):Promise<void> { return this.intents.begin(id, collectionId) }

  async publishChunk(uploadId:string, chunkId:string, publish:()=>Promise<void>):Promise<void> {
    if (!await this.intents.addChunk(uploadId, chunkId)) throw new Error('Upload cleanup intent is unavailable');
    await publish();
  }

  complete(id:string):Promise<void> { return this.intents.complete(id) }
}

export interface UploadCleanupLog { warn(message:string):void }

/**
 * Deletes chunk blobs left by uploads that never completed.
 *
 * This is destructive only at service startup, before createApp().listen(), keyring
 * initialization, LocalFilesManager construction, or indexing. It must not be scheduled
 * while any Store publisher can be active. Stale work is claimed durably before blobs are
 * deleted: a crashed cleanup remains resumable, while a request that resumes after the
 * deadline cannot publish.
 */
export class StaleUploadCleaner {
  constructor(
    private readonly intents:UploadIntentRepository,
    private readonly store:Pick<Store, 'delete'>,
    private readonly log:UploadCleanupLog = console,
    private readonly staleAge = STALE_UPLOAD_AGE,
  ) {}

  async run():Promise<number> {
    let cleaned = 0;
    for (const intent of await this.intents.claimStale(this.staleAge)) {
      const chunkIds = Array.isArray(intent.chunk_ids) ? [...new Set<string>(intent.chunk_ids.filter((id:unknown):id is string => typeof id === 'string'))] : [];
      for (const chunkId of chunkIds) {
        const state = await this.intents.chunkState(intent.collection_id, chunkId, this.staleAge);
        if (state?.registered || state?.active) continue;
        // A blob some version's manifest names is user content even without its `chunks` row (a write
        // whose row was lost on retry, repairable by files_fsck). Deleting it would make that loss permanent.
        if (await this.intents.referencedByVersion(intent.collection_id, chunkId)) {
          this.log.warn(`[SullaFiles] kept chunk ${ chunkId } of a stale upload: a version references it but its chunks row is missing (run files_fsck)`);
          continue;
        }
        await this.store.delete(intent.collection_id, chunkId);
      }
      await this.intents.deleteClaimed(intent.id);
      cleaned++;
    }
    return cleaned;
  }
}

// Function exports kept for app.ts and index.ts (outside this slice); they build the classes per call.
export function beginUploadIntent(db:pg.Pool, id:string, collectionId:string):Promise<void> {
  return new UploadIntentService(new UploadIntentRepository(db)).begin(id, collectionId);
}
export function completeUploadIntent(db:pg.Pool, id:string):Promise<void> {
  return new UploadIntentService(new UploadIntentRepository(db)).complete(id);
}
export function cleanupStaleUploads(db:pg.Pool, store:Store):Promise<number> {
  return new StaleUploadCleaner(new UploadIntentRepository(db), store).run();
}
