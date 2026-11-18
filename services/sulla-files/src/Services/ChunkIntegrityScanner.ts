// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHmac } from 'node:crypto';

import { defaultChunkCrypto, type ChunkCrypto } from '../crypto.js';
import type { ChunkIntegrityRepository, ScannedChunkRow } from '../Repositories/ChunkIntegrityRepository.js';
import type { CollectionKeys, FilesKeyring } from '../keyring.js';
import type { Store } from '../store.js';

const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 100_000;
const DEFAULT_CONCURRENCY = 4;
const BATCH_SIZE = 200;
const FINGERPRINT_CONTEXT = 'sulla-files-key-fingerprint';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ChunkIntegrityQueryError extends Error {}

export interface ChunkIntegrityScanOptions { collectionId?:string; limit?:number }

export interface CollectionChunkIntegrity {
  collectionId:string;
  /** First 8 hex chars of HMAC-SHA256(collection data key, "sulla-files-key-fingerprint"). Null when the key could not be loaded. */
  keyFingerprint:string | null;
  chunksScanned:number;
  /** Chunk ids whose stored blob does not decrypt and verify under the collection's current key. */
  undecryptable:string[];
  /** Chunk ids with no blob in the store. */
  missingBlob:string[];
  /** Chunks that could not be read for another reason (I/O, size bounds). Not decryption failures. */
  errors:number;
}

export interface ChunkIntegrityScanReport {
  scannedAt:string;
  collections:CollectionChunkIntegrity[];
  totals:{ collections:number; chunksScanned:number; undecryptable:number; missingBlob:number; errors:number };
}

type ChunkOutcome = 'healthy' | 'undecryptable' | 'missingBlob' | 'error';

/**
 * Read-only scan that lists undecryptable and missing chunks per collection. It reports chunk ids and counts only:
 * no plaintext, no key material and no file names. Plaintext is discarded as soon as it is verified.
 */
export class ChunkIntegrityScanner {
  constructor(
    private readonly repository:ChunkIntegrityRepository,
    private readonly store:Pick<Store, 'storedSize' | 'getBounded'>,
    private readonly keyring:Pick<FilesKeyring, 'keys'>,
    private readonly crypto:Pick<ChunkCrypto, 'maxEncryptedChunkBytes' | 'decryptAndVerifyChunk'> = defaultChunkCrypto,
    private readonly concurrency = DEFAULT_CONCURRENCY,
    private readonly now:() => Date = () => new Date(),
  ) {}

  /** Parses the query string of the scan route. Throws ChunkIntegrityQueryError for anything malformed. */
  static parseOptions(query:Record<string, unknown>):ChunkIntegrityScanOptions {
    const options:ChunkIntegrityScanOptions = {};
    if (query.collectionId !== undefined) {
      if (typeof query.collectionId !== 'string' || !UUID_PATTERN.test(query.collectionId)) throw new ChunkIntegrityQueryError('collectionId must be a UUID');
      options.collectionId = query.collectionId;
    }
    if (query.limit !== undefined) {
      const limit = typeof query.limit === 'string' && /^[1-9][0-9]*$/.test(query.limit) ? Number(query.limit) : NaN;
      if (!Number.isSafeInteger(limit) || limit > MAX_LIMIT) throw new ChunkIntegrityQueryError(`limit must be an integer from 1 to ${ MAX_LIMIT }`);
      options.limit = limit;
    }
    return options;
  }

  /** `limit` caps the chunks scanned per collection. */
  async scan(options:ChunkIntegrityScanOptions = {}):Promise<ChunkIntegrityScanReport> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const collections:CollectionChunkIntegrity[] = [];
    for (const collectionId of await this.repository.collectionIds(options.collectionId)) {
      collections.push(await this.scanCollection(collectionId, limit));
    }
    return {
      scannedAt: this.now().toISOString(),
      collections,
      totals: {
        collections: collections.length,
        chunksScanned: collections.reduce((sum, item) => sum + item.chunksScanned, 0),
        undecryptable: collections.reduce((sum, item) => sum + item.undecryptable.length, 0),
        missingBlob: collections.reduce((sum, item) => sum + item.missingBlob.length, 0),
        errors: collections.reduce((sum, item) => sum + item.errors, 0),
      },
    };
  }

  static fingerprint(dataKey:Uint8Array):string {
    return createHmac('sha256', dataKey).update(FINGERPRINT_CONTEXT).digest('hex').slice(0, 8);
  }

  private async scanCollection(collectionId:string, limit:number):Promise<CollectionChunkIntegrity> {
    const result:CollectionChunkIntegrity = { collectionId, keyFingerprint: null, chunksScanned: 0, undecryptable: [], missingBlob: [], errors: 0 };
    let keys:CollectionKeys;
    try { keys = await this.keyring.keys(collectionId) } catch {
      result.errors = 1;
      return result;
    }
    result.keyFingerprint = ChunkIntegrityScanner.fingerprint(keys.data);
    let afterId = '';
    while (result.chunksScanned < limit) {
      const pageSize = Math.min(BATCH_SIZE, limit - result.chunksScanned);
      const page = await this.repository.chunkPage(collectionId, afterId, pageSize);
      if (page.length === 0) break;
      afterId = page[page.length - 1].id;
      const outcomes = await this.mapBounded(page, chunk => this.check(collectionId, chunk, keys));
      outcomes.forEach((outcome, index) => {
        result.chunksScanned += 1;
        if (outcome === 'undecryptable') result.undecryptable.push(page[index].id);
        else if (outcome === 'missingBlob') result.missingBlob.push(page[index].id);
        else if (outcome === 'error') result.errors += 1;
      });
      if (page.length < pageSize) break;
    }
    result.undecryptable.sort();
    result.missingBlob.sort();
    return result;
  }

  /** Never throws and never returns plaintext. Plaintext is zeroed as soon as verification succeeds. */
  private async check(collectionId:string, chunk:ScannedChunkRow, keys:CollectionKeys):Promise<ChunkOutcome> {
    try {
      if (await this.store.storedSize(collectionId, chunk.id) === undefined) return 'missingBlob';
      const envelope = await this.store.getBounded(collectionId, chunk.id, this.crypto.maxEncryptedChunkBytes(chunk.size), chunk.storedSize);
      let plain:Buffer;
      try { plain = await this.crypto.decryptAndVerifyChunk(envelope, keys.data, keys.dedup, chunk.id, chunk.size) } catch { return 'undecryptable' }
      plain.fill(0);
      return 'healthy';
    } catch {
      return 'error';
    }
  }

  /** Runs fn over items with at most `concurrency` in flight, returning results in input order. */
  private async mapBounded<T, R>(items:T[], fn:(item:T) => Promise<R>):Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async():Promise<void> => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, () => worker()));
    return results;
  }
}
