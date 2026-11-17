// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';

import type { Store } from '../store.js';
import { openCloudChunk } from './chunkSource.js';
import type { FilesSyncCloudApi } from './cloudApi.js';
import { HttpStatusError } from './CloudSyncErrors.js';
import type { CloudSyncRepositories } from './CloudSyncRepositories.js';
import type { CollectionRootKeyProvider } from './keyStore.js';
import { buildCommitBatch, type RecursiveDeleteMetadata } from './push.js';
import type { SyncRow, UploadSession } from './repository.js';
import type { CloudStagingStore } from './staging.js';

const BASE = '/files-sync/v1';
const MAX_CONCURRENT_CHUNK_UPLOADS = 4;

/** One collection's open upload: resumable chunk PUTs, the queued commit, and dropping it cleanly. */
export class CloudUploadSessions {
  constructor(
    private readonly repositories:CloudSyncRepositories,
    private readonly api:FilesSyncCloudApi,
    private readonly staging:CloudStagingStore,
    private readonly roots:CollectionRootKeyProvider,
    private readonly store:Store,
  ) {}

  /** Resumable chunk upload: ask the server what is still missing, PUT those wires, then queue the commit. */
  async continueUpload(sync:SyncRow, session:UploadSession, root:Uint8Array):Promise<void> {
    const collectionId = sync.collectionId;
    if (!session.uploadId) {
      await this.dropSession(collectionId);
      return;
    }
    const remote = await this.api.uploadStatus(session.uploadId);
    if (!remote) {
      await this.dropSession(collectionId);
      return;
    }
    const staged = new Set(session.staged);
    for (const id of remote.missing) {
      if (!staged.has(id)) {
        // A chunk we thought Cloud held is gone; forget it so the next staging re-seals it.
        await this.repositories.chunks.forgetUpload(collectionId, [id]);
        await this.dropSession(collectionId);
        return;
      }
    }
    if (await this.uploadMissingChunks(collectionId, session.uploadId, remote.missing, session)) {
      await this.dropSession(collectionId);
      return;
    }
    await this.repositories.state.saveSession(collectionId, session, 0, 'syncing');
    await this.queueCommit(sync, session, root);
  }

  /** PUT independent ciphertext chunks concurrently, but keep version commit ordering serial. */
  private async uploadMissingChunks(collectionId:string, uploadId:string, missing:string[], session:UploadSession):Promise<boolean> {
    let next = 0;
    let expired = false;
    let failure:Error | undefined;
    const worker = async():Promise<void> => {
      while (!expired && !failure) {
        const index = next++;
        if (index >= missing.length) return;
        const id = missing[index];
        let wire:Buffer;
        try {
          wire = await this.staging.get(collectionId, id);
        } catch {
          expired = true;
          return;
        }
        const status = await this.api.putChunk(uploadId, id, wire);
        if (status === 200 || status === 201) {
          await this.repositories.chunks.markUploaded(collectionId, id);
        } else if (status === 409) {
          // Cloud already holds different bytes for this id; verify and adopt them after the commit.
          if (!session.present.includes(id)) session.present.push(id);
        } else if (status === 404 || status === 410) {
          expired = true;
        } else {
          failure = Object.assign(new Error(`Chunk upload failed (${ status })`), { status });
        }
      }
    };
    const count = Math.min(MAX_CONCURRENT_CHUNK_UPLOADS, missing.length);
    await Promise.all(Array.from({length:count}, () => worker()));
    if (failure) throw failure;
    return expired;
  }

  async queueCommit(sync:SyncRow, session:UploadSession | UploadSession[], root:Uint8Array, batch?:RecursiveDeleteMetadata):Promise<void> {
    const sessions=Array.isArray(session)?session:[session];
    const commit = await buildCommitBatch(sync, sessions, this.repositories.heads.cloudHeadPages(sync.collectionId), root, batch);
    await this.repositories.operations.queue(sync.collectionId, 'commit', `${ BASE }/collections/${ sync.collectionId }/commit`, 'POST', commit.body, commit.sha256, randomUUID(), { head: commit.head });
  }

  /**
   * Chunks we sealed but Cloud already held (another device wrote the same plaintext):
   * our recorded sha256 is not the server's, so fetch, open and verify the server copy
   * and record its real bytes. Until that succeeds the chunk is never evictable.
   */
  async adoptPresentCopies(sync:SyncRow, session:UploadSession):Promise<void> {
    const ours = new Set(session.staged);
    const adopt = session.present.filter(id => ours.has(id));
    if (!adopt.length) return;
    const root = await this.roots.unwrap(sync.collectionId, sync.keyVersion, sync.wrappedRoot!);
    try {
      for (const id of adopt) {
        try {
          const wire = await this.api.getChunk(sync.collectionId, id);
          const plain = await openCloudChunk(root, sync.collectionId, sync.keyVersion, id, wire);
          plain.fill(0);
          await this.repositories.chunks.adoptServerCopy(sync.collectionId, id, createHash('sha256').update(wire).digest('hex'), wire.length);
        } catch {
          await this.repositories.chunks.forgetUpload(sync.collectionId, [id]);
        }
      }
    } finally {
      root.fill(0);
    }
  }

  /** Reads every evicted chunk back through the caching store, which hydrates it from Cloud. */
  async rehydrateEvicted(collectionId:string):Promise<void> {
    for (const chunkId of await this.repositories.chunks.evictedChunks(collectionId)) {
      try {
        const encrypted = await this.store.get(collectionId, chunkId);
        encrypted.fill(0);
      } catch (error:any) {
        throw new HttpStatusError(409, error?.code === 'FILE_OFFLINE'
          ? 'Some files are only in Sulla Cloud and could not be downloaded; try again when online'
          : 'Some files are only in Sulla Cloud and could not be downloaded');
      }
    }
  }

  async dropSession(collectionId:string):Promise<void> {
    const uploadId = (await this.repositories.state.sync(collectionId))?.uploadSession?.uploadId;
    if (uploadId) await this.api.abortUpload(uploadId).catch(() => undefined);
    await this.staging.clear(collectionId);
    await this.repositories.operations.dropCollectionOperations(collectionId, ['upload-open', 'commit']);
    await this.repositories.state.saveSession(collectionId, null, 0, 'idle');
  }

  /** Cipher bytes still to upload: staged chunks the server reported missing (all staged ones when unknown). */
  pendingBytes(session:UploadSession, missing?:Set<unknown>):number {
    const staged = new Set(session.staged);
    return session.declared
      .filter(chunk => staged.has(chunk.id) && (!missing || missing.has(chunk.id)))
      .reduce((total, chunk) => total + chunk.cipherBytes, 0);
  }
}
