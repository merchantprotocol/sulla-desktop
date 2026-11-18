// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

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

export interface StagerKeyring { keys(collectionId:string):Promise<{ data:Uint8Array; dedup:Uint8Array }> }
export interface StagerChunkStore {
  storedSize(collectionId:string, id:string):Promise<number | undefined>;
  put(collectionId:string, id:string, bytes:Uint8Array):Promise<unknown>;
  putStaged?(collectionId:string, id:string, bytes:Uint8Array):Promise<unknown>;
}
export interface StagerCrypto {
  chunkId(plain:Uint8Array, dedupKey:Uint8Array):string;
  encryptChunk(plain:Uint8Array, dataKey:Uint8Array, id:string):Promise<Uint8Array>;
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
    const chunkIds:string[] = []; const chunks = new Map<string, { id:string; size:number; storedSize:number }>();
    for (let offset = 0; offset < Math.max(1, bytes.length); offset += VERSION_CHUNK_BYTES) {
      const plain = bytes.subarray(offset, Math.min(bytes.length, offset + VERSION_CHUNK_BYTES));
      const id = this.crypto.chunkId(plain, dedup); chunkIds.push(id);
      if (chunks.has(id)) continue;
      const existing = await this.store.storedSize(collectionId, id);
      if (existing !== undefined) { chunks.set(id, { id, size: plain.length, storedSize: existing }); continue }
      const encrypted = await this.crypto.encryptChunk(plain, data, id);
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
