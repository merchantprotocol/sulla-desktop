// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import type pg from 'pg';

import { chunkId as localChunkId, decryptAndVerifyChunk, encryptChunk } from '../crypto.js';
import type { FilesKeyring } from '../keyring.js';
import { PgCloudChunkMapRepository } from '../Repositories/CloudChunkMapRepository.js';
import type { Store } from '../store.js';
import { openCloudChunk } from './chunkSource.js';
import type { FilesSyncCloudApi } from './cloudApi.js';
import type { ManifestPlain } from './envelope.js';
import type { MaterializedContent, RemoteContentSource } from './pull.js';
import { CloudSyncIntegrityError } from './validation.js';

/**
 * Materializes a remote version into the local encrypted chunk store.
 *
 * Choice (lead finding #12): eager download, then evictable. Local chunk ids are
 * HMACs of the plaintext under the local dedup key, so a lazy row would need a
 * local id we cannot know without the plaintext. Instead each chunk is fetched
 * once, verified (cloud id, size, whole-file sha256), re-encrypted locally and
 * written through the caching store, which records it 'resident' in
 * files_chunk_cache. Its files_cloud_chunk_map row is verified (the bytes came
 * from the server), so P4 may evict it later in stored-only mode and hydrate it
 * on the next read. Chunks already present locally are reused, not re-downloaded.
 */
export class CloudRemoteContent implements RemoteContentSource {
  constructor(
    db:Pick<pg.Pool, 'query'>,
    private readonly api:Pick<FilesSyncCloudApi, 'getChunk'>,
    private readonly keyring:Pick<FilesKeyring, 'keys'>,
    private readonly store:Store,
    private readonly copies:Pick<PgCloudChunkMapRepository, 'localCopyOf' | 'recordDownloadedCopy'> = new PgCloudChunkMapRepository(db),
  ) {}

  async materialize(collectionId:string, keyVersion:number, root:Uint8Array, manifest:ManifestPlain):Promise<MaterializedContent> {
    const keys = await this.keyring.keys(collectionId);
    const whole = createHash('sha256');
    const chunkIds:string[] = [];
    const chunks = new Map<string, { id:string; size:number; storedSize:number }>();
    let total = 0;
    for (const [cloudChunkId, plainBytes] of manifest.chunks) {
      const plain = await this.chunkPlain(collectionId, keyVersion, root, cloudChunkId, plainBytes, keys);
      try {
        whole.update(plain.bytes);
        total += plain.bytes.length;
        chunkIds.push(plain.localId);
        if (!chunks.has(plain.localId)) chunks.set(plain.localId, { id: plain.localId, size: plain.bytes.length, storedSize: plain.storedSize });
      } finally {
        plain.bytes.fill(0);
      }
    }
    if (total !== manifest.size || whole.digest('hex') !== manifest.sha256) {
      throw new CloudSyncIntegrityError('Remote file content does not match its manifest');
    }
    return { chunkIds, chunks: [...chunks.values()] };
  }

  private async chunkPlain(
    collectionId:string,
    keyVersion:number,
    root:Uint8Array,
    cloudChunkId:string,
    plainBytes:number,
    keys:{ data:Uint8Array; dedup:Uint8Array },
  ):Promise<{ localId:string; bytes:Buffer; storedSize:number }> {
    const mapped = await this.copies.localCopyOf(collectionId, cloudChunkId);
    if (mapped) {
      // Already local (possibly evicted; the caching store hydrates it). Read it to keep the whole-file hash honest.
      const encrypted = await this.store.get(collectionId, mapped.localChunkId);
      const bytes = await decryptAndVerifyChunk(encrypted, keys.data, keys.dedup, mapped.localChunkId, plainBytes);
      return { localId: mapped.localChunkId, bytes, storedSize: mapped.storedSize };
    }
    const wire = await this.api.getChunk(collectionId, cloudChunkId);
    const bytes = await openCloudChunk(root, collectionId, keyVersion, cloudChunkId, wire, plainBytes);
    const localId = localChunkId(bytes, keys.dedup);
    const encrypted = await encryptChunk(bytes, keys.data, localId);
    await this.store.put(collectionId, localId, encrypted);
    await this.copies.recordDownloadedCopy(collectionId, localId, cloudChunkId, createHash('sha256').update(wire).digest('hex'), wire.length);
    return { localId, bytes, storedSize: encrypted.length };
  }
}
