// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readdir } from 'node:fs/promises';

import { defaultChunkCrypto, type ChunkCrypto } from './crypto.js';
import { TransactionRunner } from './FilesTransaction.js';
import { ChunkMetadataRepairRepository } from './Repositories/ChunkMetadataRepairRepository.js';
import type { FilesKeyring } from './keyring.js';
import type { Store } from './store.js';
import type pg from 'pg';

const CHUNK_BYTES = 4 * 1024 * 1024;

export interface ChunkRepairItem { collectionId:string; id:string; size:number; storedSize:number; refcount:number; location:string }
export interface ChunkRepairReport { dryRun:boolean; missingMetadata:ChunkRepairItem[]; restored:ChunkRepairItem[]; unverifiable:{collectionId:string;id:string;reason:string}[]; temporaryFiles:string[] }

/** Authenticated, metadata-only repair. Chunk files are read but never modified. */
export class ChunkMetadataReconciler {
  constructor(
    db:pg.Pool,
    private readonly store:Store,
    private readonly keyring:FilesKeyring,
    private readonly repairs = new ChunkMetadataRepairRepository(db),
    private readonly transactions = new TransactionRunner(db),
    private readonly crypto:Pick<ChunkCrypto, 'maxEncryptedChunkBytes' | 'decryptAndVerifyChunk'> = defaultChunkCrypto,
  ) {}

  async run(options:{apply?:boolean} = {}):Promise<ChunkRepairReport> {
    const dryRun = options.apply !== true;
    const refs = await this.repairs.missingReferences();
    const sizes = new Map<string, {collectionId:string;id:string;size:number}>();
    const conflictingSizes = new Set<string>();
    const unverifiable:ChunkRepairReport['unverifiable'] = [];
    for (const row of refs) {
      const collectionId = String(row.collection_id), id = String(row.id);
      const count = Number(row.chunk_count), index = Number(row.position) - 1, total = Number(row.total_size);
      const expected = index < count - 1 ? CHUNK_BYTES : total - CHUNK_BYTES * (count - 1);
      const key = `${collectionId}:${id}`;
      if (!Number.isSafeInteger(expected) || expected <= 0 || expected > CHUNK_BYTES) {
        unverifiable.push({ collectionId, id, reason: 'manifest has invalid chunk sizing' }); conflictingSizes.add(key); sizes.delete(key); continue;
      }
      const prior = sizes.get(key);
      if (prior && prior.size !== expected) {
        unverifiable.push({ collectionId, id, reason: 'deduplicated chunk has conflicting inferred plaintext sizes' });
        sizes.delete(key); conflictingSizes.add(key); continue;
      }
      if (!conflictingSizes.has(key)) sizes.set(key, { collectionId, id, size: expected });
    }
    const verified:ChunkRepairItem[] = [];
    for (const candidate of sizes.values()) {
      try {
        const keys = await this.keyring.keys(candidate.collectionId);
        const storedSize = await this.store.storedSize(candidate.collectionId, candidate.id);
        if (storedSize === undefined || storedSize < 1 || storedSize > this.crypto.maxEncryptedChunkBytes(candidate.size)) throw new Error('chunk file is absent or outside encrypted size bounds');
        const envelope = await this.store.getBounded(candidate.collectionId, candidate.id, this.crypto.maxEncryptedChunkBytes(candidate.size), storedSize);
        await this.crypto.decryptAndVerifyChunk(envelope, keys.data, keys.dedup, candidate.id, candidate.size);
        verified.push({ ...candidate, storedSize, refcount: 0, location: `chunks/${candidate.collectionId}/${candidate.id}` });
      } catch (error) {
        unverifiable.push({ collectionId:candidate.collectionId, id:candidate.id, reason:String((error as Error)?.message ?? error) });
      }
    }
    const missingMetadata = verified.map(item => ({ ...item }));
    const restored:ChunkRepairItem[] = [];
    if (!dryRun && verified.length) {
      await this.transactions.run('chunk-metadata-repair', async client => {
        await this.repairs.lockVersions(client);
        for (const item of verified) {
          if (await this.repairs.chunkExists(client, item.collectionId, item.id)) continue;
          const refsNow = await this.repairs.versionReferenceCount(client, item.collectionId, item.id);
          if (await this.repairs.insertRestored(client, { ...item, refcount:refsNow })) restored.push({ ...item, refcount:refsNow });
        }
      });
    }
    return { dryRun, missingMetadata, restored, unverifiable, temporaryFiles:await this.temporaryFiles() };
  }

  private async temporaryFiles():Promise<string[]> {
    const found:string[] = [];
    for (const collection of await readdir(this.store.rootPath, { withFileTypes:true }).catch(() => [])) {
      if (!collection.isDirectory()) continue;
      const collectionPath = `${this.store.rootPath}/${collection.name}`;
      for (const prefix of await readdir(collectionPath, { withFileTypes:true }).catch(() => [])) {
        if (!prefix.isDirectory()) continue;
        const prefixPath = `${collectionPath}/${prefix.name}`;
        for (const entry of await readdir(prefixPath, { withFileTypes:true }).catch(() => [])) {
          if (entry.isFile() && entry.name.includes('.tmp-')) found.push(`${collection.name}/${prefix.name}/${entry.name}`);
        }
      }
    }
    return found.sort();
  }
}
