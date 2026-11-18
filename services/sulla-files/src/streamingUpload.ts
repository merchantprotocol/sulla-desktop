// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { defaultChunkCrypto, type ChunkCrypto } from './crypto.js';
import { UploadIntentService } from './uploadCleanup.js';
import { PublicationLifecyclePolicy, type PublicationCollection } from './publicationLifecyclePolicy.js';
import { PlaintextChunkReader } from './plaintextChunkReader.js';
import { ManifestChunkRegistry } from './ManifestChunkRegistry.js';
import { CollectionPolicyRepository } from './Repositories/CollectionPolicyRepository.js';
import { StreamedUploadRepository, type UploadedChunk } from './Repositories/StreamedUploadRepository.js';
import { UploadIntentRepository } from './Repositories/UploadIntentRepository.js';
export { PlaintextChunkReader } from './plaintextChunkReader.js';

import type { FilesIdentity } from './auth.js';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { Readable } from 'node:stream';
import type pg from 'pg';

interface StreamingUploadInput {
  uploadId:      string;
  collectionId:  string;
  path:          string;
  mime:          string;
  expectedBytes?: number;
  maxBytes?: number;
  actor:         FilesIdentity;
  body:          Readable;
  intentDb:      pg.Pool;
  existingFile?: { id:string; current_version_id:string };
  message?:      string;
}

export interface StreamedUpload {
  chunkIds:string[];
  chunks:UploadedChunk[];
  totalSize:number;
  sourceHash:string;
}

type StreamInput = Pick<StreamingUploadInput, 'uploadId' | 'collectionId' | 'expectedBytes' | 'maxBytes' | 'body' | 'intentDb'>;
type ChunkStore = Pick<Store, 'put' | 'getBounded'> & Partial<Pick<Store,'quarantineAndReplace'>>;

/**
 * Streams an upload into encrypted chunks (phase 1, no transaction) and commits its metadata
 * (phase 2, a short transaction on the caller's client). Phase 2 refuses to record a version
 * whose chunk rows are missing (ManifestChunkRegistry) or whose existing manifest/chunk rows
 * disagree with the uploaded bytes.
 */
export class StreamingUploadService {
  constructor(
    private readonly crypto:ChunkCrypto = defaultChunkCrypto,
    private readonly uploads = new StreamedUploadRepository(),
    private readonly registry = new ManifestChunkRegistry(),
    private readonly collections = new CollectionPolicyRepository(),
    private readonly publication = new PublicationLifecyclePolicy(),
    private readonly intentsFor:(db:pg.Pool) => UploadIntentService = db => new UploadIntentService(new UploadIntentRepository(db)),
  ) {}

  /** Phase 1: read the request body, encrypt and publish chunks under the upload intent.
   * Uses no transaction, so a slow client never holds a database transaction or the
   * namespace lock open (idle-in-transaction is killed after 60 s). */
  async streamChunks(config:Config, store:ChunkStore, input:StreamInput):Promise<StreamedUpload> {
    const { data: dataKey, dedup: dedupKey } = await config.keyring!.keys(input.collectionId);
    let activeKeys:{data:Uint8Array; dedup:Uint8Array} | undefined;
    try {
    if (config.keyring!.keysFresh) activeKeys = await config.keyring!.keysFresh(input.collectionId);
    if (activeKeys && (!this.crypto.keysMatch(dataKey, activeKeys.data) || !this.crypto.keysMatch(dedupKey, activeKeys.dedup))) {
      config.keyring!.invalidate?.(input.collectionId);
      throw Object.assign(new Error('Collection key changed during upload staging'), { status:503, code:'collection_key_unavailable', retryAfter:1 });
    }
    const intents = this.intentsFor(input.intentDb);
    const chunkIds:string[] = [];
    const chunks:UploadedChunk[] = [];
    const sourceHash = createHash('sha256');
    let totalSize = 0;

    for await (const plain of new PlaintextChunkReader(input.body, input.expectedBytes, input.maxBytes).chunks()) {
      totalSize += plain.byteLength;
      sourceHash.update(plain);
      const id = this.crypto.chunkId(plain, dedupKey);
      chunkIds.push(id);
      if (activeKeys && this.crypto.chunkId(plain, activeKeys.dedup) !== id) {
        config.keyring!.invalidate?.(input.collectionId);
        throw Object.assign(new Error('Collection dedup key changed during upload staging'), { status:503, code:'collection_key_unavailable', retryAfter:1 });
      }
      const encrypted = activeKeys
        ? await this.crypto.encryptChunkForCollection(plain, dataKey, id, activeKeys.data, input.collectionId)
        : await this.crypto.encryptChunk(plain, dataKey, id);
      const maxStoredBytes = this.crypto.maxEncryptedChunkBytes(plain.byteLength);
      if (encrypted.byteLength > maxStoredBytes) throw new Error('Encrypted chunk exceeded its derived envelope bound');
      await intents.publishChunk(input.uploadId, id, async() => {
        const published = await store.put(input.collectionId, id, encrypted);
        if (!published) {
          const winner = await store.getBounded(input.collectionId, id, maxStoredBytes, encrypted.byteLength);
          try { await this.crypto.decryptAndVerifyChunk(winner, dataKey, dedupKey, id, plain.byteLength) }
          catch (error) {
            if (!store.quarantineAndReplace || !activeKeys) throw error;
            const refs=await store.quarantineAndReplace(input.collectionId,id,encrypted);
            await input.intentDb.query('INSERT INTO file_chunk_quarantine(collection_id,chunk_id,old_blob_ref,new_blob_ref,reason) VALUES($1,$2,$3,$4,$5)',
              [input.collectionId,id,refs.oldBlobRef,refs.newBlobRef,'decrypt_verify_failed']);
          }
        }
      });
      chunks.push({ id, size: plain.byteLength, storedSize: encrypted.byteLength });
    }

    return { chunkIds, chunks, totalSize, sourceHash: sourceHash.digest('hex') };
    } finally { activeKeys?.data.fill(0); activeKeys?.dedup.fill(0); dataKey.fill(0); dedupKey.fill(0) }
  }

  /** Phase 2: short metadata transaction on `client` (caller holds BEGIN and the namespace lock). */
  async commit(client:pg.PoolClient, input:StreamingUploadInput, streamed:StreamedUpload):Promise<any> {
    const { chunkIds, chunks, totalSize } = streamed;
    const manifestHash = createHash('sha256').update(JSON.stringify({ ids: chunkIds, size: totalSize })).digest('hex');
    await this.assertManifestMetadata(client, manifestHash, chunkIds, totalSize);
    for (const chunk of chunks) await this.assertChunkMetadata(client, input.collectionId, chunk);
    await this.registry.assertRegistered(client, input.collectionId, chunkIds);
    const agentWrite = Boolean(input.actor.agentId || input.actor.jobId || input.actor.threadId);
    const collection = await this.collections.findPublicationPolicy(client, input.collectionId);
    const createdByType = agentWrite ? 'agent-run' : 'user';
    const createdById = input.actor.jobId ?? input.actor.agentId ?? input.actor.userId;
    const publicationStatus = this.publication.statusForWrite({ collection: collection as PublicationCollection, path:input.path, createdByType });
    const file = input.existingFile
      ? await this.uploads.updateFile(client, input.existingFile.id, input.mime, totalSize)
      : await this.uploads.insertFile(client, { collectionId: input.collectionId, path: input.path, createdByType, createdById, mime: input.mime, size: totalSize });
    const version = await this.uploads.insertVersion(client, {
      fileId: file.id, collectionId: input.collectionId, parentVersionId: input.existingFile?.current_version_id ?? null, manifestHash, size: totalSize,
      createdByType, createdById, message: input.message ?? 'Imported into Files', deviceId: input.actor.deviceId || 'server-web', publicationStatus,
    });
    await this.uploads.setCurrentVersion(client, file.id, version.id);
    await this.uploads.incrementRefcounts(client, input.collectionId, chunkIds);
    await this.uploads.journalPut(client, input.collectionId, file.id, version.id);
    await this.uploads.audit(client, {
      whoType: agentWrite ? 'agent-or-device' : 'user', whoId: createdById, deviceId: input.actor.deviceId || null, fileId: file.id, versionId: version.id,
      action: version.publication_status === 'draft' ? 'draft-write' : 'upload', path: input.path,
    });
    return { ...file, current_version_id: version.id, size: totalSize, path: input.path, mime: input.mime, source_hash: streamed.sourceHash };
  }

  private async assertManifestMetadata(client:pg.PoolClient, hash:string, chunkIds:string[], totalSize:number):Promise<void> {
    if (await this.uploads.insertManifest(client, hash, chunkIds, totalSize)) return;
    const existing = await this.uploads.findManifest(client, hash);
    if (!existing || JSON.stringify(existing.chunk_ids) !== JSON.stringify(chunkIds) || Number(existing.total_size) !== totalSize) {
      throw new Error('Existing manifest metadata does not match uploaded content');
    }
  }

  private async assertChunkMetadata(client:pg.PoolClient, collectionId:string, chunk:UploadedChunk):Promise<void> {
    const location = `chunks/${ collectionId }/${ chunk.id }`;
    if (await this.uploads.insertChunk(client, collectionId, chunk, location)) return;
    const existing = await this.uploads.findChunk(client, collectionId, chunk.id);
    if (!existing || Number(existing.size) !== chunk.size || Number(existing.stored_size) !== chunk.storedSize || existing.location !== location) {
      throw new Error('Existing chunk metadata does not match uploaded content');
    }
  }
}

// Function exports kept for app.ts (outside this slice); each call uses a fresh stateless service.
export function streamUploadChunks(config:Config, store:Store, input:StreamInput):Promise<StreamedUpload> {
  return new StreamingUploadService().streamChunks(config, store, input);
}
export function commitStreamedUpload(client:pg.PoolClient, input:StreamingUploadInput, streamed:StreamedUpload):Promise<any> {
  return new StreamingUploadService().commit(client, input, streamed);
}
/** Both phases on one client (kept for the 64 MiB FUSE replace path). */
export async function insertStreamingUpload(client:pg.PoolClient, config:Config, store:Store, input:StreamingUploadInput):Promise<any> {
  const service = new StreamingUploadService();
  return service.commit(client, input, await service.streamChunks(config, store, input));
}
