// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import { defaultChunkCrypto } from './crypto.js';

import type { FilesMetrics } from './FilesMetrics.js';
import { TransactionScope } from './TransactionScope.js';

export const VERSION_CHUNK_BYTES = 4 * 1024 * 1024;

/** Content already encrypted and durable in the chunk store, ready for a short commit transaction. */
export interface StagedVersionContent {
  readonly collectionId:string;
  readonly size:number;
  readonly chunkIds:readonly string[];
  /** Every distinct chunk with its stored size; the commit records any missing `chunks` rows. */
  readonly chunks:readonly { id:string; size:number; storedSize:number }[];
  readonly manifestHash:string;
  /** sha256 of the plaintext, the hash the mount compares for idempotent replays. */
  readonly sourceHash:string;
}

export interface StagerKeyring { keys(collectionId:string):Promise<{ data:Uint8Array; dedup:Uint8Array }>; keysFresh?(collectionId:string):Promise<{ data:Uint8Array; dedup:Uint8Array }>; invalidate?(collectionId:string):void }
export interface StagerChunkStore {
  storedSize(collectionId:string, id:string):Promise<number | undefined>;
  getBounded?(collectionId:string, id:string, maxBytes:number, expectedBytes:number):Promise<Uint8Array>;
  put(collectionId:string, id:string, bytes:Uint8Array):Promise<unknown>;
  putStaged?(collectionId:string, id:string, bytes:Uint8Array):Promise<unknown>;
}
export interface StagerCrypto {
  chunkId(plain:Uint8Array, dedupKey:Uint8Array):string;
  encryptChunk(plain:Uint8Array, dataKey:Uint8Array, id:string):Promise<Uint8Array>;
  encryptChunkForCollection?(plain:Uint8Array, dataKey:Uint8Array, id:string, activeDataKey:Uint8Array, collectionId:string):Promise<Uint8Array>;
  decryptAndVerifyChunk?(value:Uint8Array, dataKey:Uint8Array, dedupKey:Uint8Array, id:string, expectedPlainBytes:number):Promise<Uint8Array>;
}

export class ChunkKeyMismatchError extends Error {
  readonly status = 422;
  readonly code = 'chunk_key_mismatch';
  constructor(readonly collectionId:string, readonly chunkId:string) { super(`Stored chunk cannot be decrypted with collection key: ${chunkId}`) }
}

/**
 * Does every slow part of writing a version (key lookup, chunk ids, encryption, fsync'd chunk
 * writes) before any database transaction opens. A chunk written here and never committed is
 * only an unreferenced content-addressed blob; it can never become a half-written version.
 */
export class VersionContentStager {
  constructor(private readonly keyring:StagerKeyring, private readonly store:StagerChunkStore, private readonly crypto:StagerCrypto,
    private readonly metrics?:FilesMetrics) {}

  async stage(collectionId:string, bytes:Buffer):Promise<StagedVersionContent> {
    const started = performance.now();
    try { return await this.stageContent(collectionId, bytes) }
    finally { this.metrics?.observeStage(performance.now() - started) }
  }

  private async stageContent(collectionId:string, bytes:Buffer):Promise<StagedVersionContent> {
    TransactionScope.assertOutside('staging version content (key lookup, encrypt, fsync)');
    const { data, dedup } = await this.keyring.keys(collectionId);
    if (this.keyring.keysFresh) {
      const active = await this.keyring.keysFresh(collectionId);
      try {
        if (!defaultChunkCrypto.keysMatch(data, active.data) || !defaultChunkCrypto.keysMatch(dedup, active.dedup)) {
          console.error('[SullaFiles] collection key mismatch before chunk staging', { collectionId, keyVersion:null, keyFingerprint:defaultChunkCrypto.keyFingerprint(data), activeKeyFingerprint:defaultChunkCrypto.keyFingerprint(active.data) });
          this.keyring.invalidate?.(collectionId);
          throw Object.assign(new Error('Collection key changed during chunk staging'), { status:503, code:'collection_key_unavailable', retryAfter:1 });
        }
      } finally { active.data.fill(0); active.dedup.fill(0) }
    }
    const chunkIds:string[] = []; const chunks = new Map<string, { id:string; size:number; storedSize:number }>();
    for (let offset = 0; offset < Math.max(1, bytes.length); offset += VERSION_CHUNK_BYTES) {
      const plain = bytes.subarray(offset, Math.min(bytes.length, offset + VERSION_CHUNK_BYTES));
      const id = this.crypto.chunkId(plain, dedup); chunkIds.push(id);
      if (chunks.has(id)) continue;
      const existing = await this.store.storedSize(collectionId, id);
      if (existing !== undefined) {
        if (!this.store.getBounded || !this.crypto.decryptAndVerifyChunk) throw new Error('Chunk dedupe requires ciphertext verification support');
        const ciphertext = await this.store.getBounded(collectionId, id, existing, existing);
        try {
          await this.crypto.decryptAndVerifyChunk(ciphertext, data, dedup, id, plain.length);
        } catch { throw new ChunkKeyMismatchError(collectionId, id) }
        chunks.set(id, { id, size: plain.length, storedSize: existing }); continue;
      }
      let encrypted:Uint8Array;
      if (this.keyring.keysFresh && this.crypto.encryptChunkForCollection) {
        let active:{data:Uint8Array; dedup:Uint8Array} | undefined;
        try {
          active = await this.keyring.keysFresh(collectionId);
          if (this.crypto.chunkId(plain, active.dedup) !== id) {
            const usedFingerprint = defaultChunkCrypto.keyFingerprint(dedup);
            const activeFingerprint = defaultChunkCrypto.keyFingerprint(active.dedup);
            console.error('[SullaFiles] collection dedup key mismatch at chunk encryption', { collectionId, keyVersion:null, keyFingerprint:usedFingerprint, activeKeyFingerprint:activeFingerprint });
            this.keyring.invalidate?.(collectionId);
            throw Object.assign(new Error('Collection key changed during chunk staging'), { status:503, code:'collection_key_unavailable', retryAfter:1 });
          }
          encrypted = await this.crypto.encryptChunkForCollection(plain, data, id, active.data, collectionId);
        } catch (error) {
          if ((error as any)?.code === 'collection_key_unavailable') this.keyring.invalidate?.(collectionId);
          throw error;
        } finally { active?.data.fill(0); active?.dedup.fill(0) }
      } else encrypted = await this.crypto.encryptChunk(plain, data, id);
      const writeStarted = performance.now();
      await (this.store.putStaged ?? this.store.put).call(this.store, collectionId, id, encrypted);
      this.metrics?.observeChunkWrite(performance.now() - writeStarted);
      chunks.set(id, { id, size: plain.length, storedSize: encrypted.length });
    }
    return {
      collectionId, size: bytes.length, chunkIds, chunks: [...chunks.values()],
      manifestHash: createHash('sha256').update(JSON.stringify({ ids: chunkIds, size: bytes.length })).digest('hex'),
      sourceHash: createHash('sha256').update(bytes).digest('hex'),
    };
  }
}
