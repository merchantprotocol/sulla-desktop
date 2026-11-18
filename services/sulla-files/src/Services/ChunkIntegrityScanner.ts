// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHmac } from 'node:crypto';
import * as zlib from 'node:zlib';

import { defaultChunkCrypto, type ChunkCrypto, type Envelope } from '../crypto.js';
import type { ChunkIntegrityRepository, ScannedChunkRow } from '../Repositories/ChunkIntegrityRepository.js';
import type { CollectionKeys, FilesKeyring } from '../keyring.js';
import type { Store } from '../store.js';

const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 100_000;
const DEFAULT_CONCURRENCY = 4;
const BATCH_SIZE = 200;
const FINGERPRINT_CONTEXT = 'sulla-files-key-fingerprint';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Hard cap on decompressed bytes while diagnosing. Chunks are far smaller; this only stops a runaway stream. */
const MAX_PLAIN_BYTES = 16 * 1024 * 1024;
/** At most this many failing chunks get the cross-collection key probe per scan request. */
const DIAGNOSE_CHUNK_CAP = 50;

export class ChunkIntegrityQueryError extends Error {}

export interface ChunkIntegrityScanOptions { collectionId?:string; limit?:number; diagnose?:boolean }

/** Where a chunk fails. `envelope_parse`: the stored blob is not a valid envelope. `aead`: the data key or AAD does not open it. `decompress`: zstd fails or exceeds the cap. `size_mismatch`: plaintext length differs from the row size. `identity_mismatch`: HMAC(dedup key, plaintext) differs from the id. */
export type ChunkFailureStage = 'envelope_parse' | 'aead' | 'decompress' | 'size_mismatch' | 'identity_mismatch';

export interface ChunkOpensWith { collectionId:string; keyFingerprint:string }

export interface ChunkFailure {
  chunkId:string;
  stage:ChunkFailureStage;
  /** Actual decompressed length. Set only for size_mismatch. A number, never content. */
  plainBytes?:number;
  /** Set only with diagnose=1 on aead failures: the other collection whose data key opens the chunk, or null when none does. Absent otherwise. */
  opensWith?:ChunkOpensWith | null;
}

export interface CollectionChunkIntegrity {
  collectionId:string;
  /** First 8 hex chars of HMAC-SHA256(collection data key, "sulla-files-key-fingerprint"). Null when the key could not be loaded. */
  keyFingerprint:string | null;
  chunksScanned:number;
  /** Chunk ids whose stored blob does not decrypt and verify under the collection's current key. Every failure stage is included. */
  undecryptable:string[];
  /** Per-chunk failure stage for every entry in `undecryptable`, sorted by chunk id. */
  failures:ChunkFailure[];
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

type ChunkCheck =
  | { outcome:'healthy' | 'missingBlob' | 'error' }
  | { outcome:'failed'; failure:ChunkFailure; envelope?:Envelope };

/** Keys the scanner needs from the keyring. Keys come from the keyring cache and are never zeroed here. */
type KeySource = Pick<FilesKeyring, 'keys'>;
type ChunkDecryptor = Pick<ChunkCrypto, 'maxEncryptedChunkBytes' | 'decrypt' | 'chunkId'>;

function aadFor(chunkId:string):string { return `sulla:file-chunk:v1:${ chunkId }` }

function isEnvelope(value:unknown):value is Envelope {
  return typeof value === 'object' && value !== null
    && typeof (value as { nonce?:unknown }).nonce === 'string'
    && typeof (value as { ciphertext?:unknown }).ciphertext === 'string';
}

/**
 * For aead failures with diagnose=1: tries the data key of every other collection that owns chunk rows.
 * The probe only opens the AEAD envelope (the AAD binds it to the chunk id). It returns ids and fingerprints only.
 */
class KeyOpenProbe {
  private remaining = DIAGNOSE_CHUNK_CAP;
  private candidates?:Promise<string[]>;
  private readonly keysByCollection = new Map<string, Promise<CollectionKeys | null>>();

  constructor(
    private readonly repository:Pick<ChunkIntegrityRepository, 'collectionIds'>,
    private readonly keyring:KeySource,
    private readonly crypto:ChunkDecryptor,
  ) {}

  /** Reserves one diagnosis slot. Returns false once the per-request cap is spent. */
  reserve():boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }

  async findOpener(ownCollectionId:string, chunkId:string, envelope:Envelope):Promise<ChunkOpensWith | null> {
    for (const other of await this.allCollections()) {
      if (other === ownCollectionId) continue;
      const keys = await this.keysFor(other);
      if (!keys) continue;
      try {
        await this.crypto.decrypt(envelope, keys.data, aadFor(chunkId));
        return { collectionId: other, keyFingerprint: ChunkIntegrityScanner.fingerprint(keys.data) };
      } catch { /* this collection's key does not open the chunk */ }
    }
    return null;
  }

  private allCollections():Promise<string[]> {
    this.candidates ??= this.repository.collectionIds();
    return this.candidates;
  }

  private keysFor(collectionId:string):Promise<CollectionKeys | null> {
    let keys = this.keysByCollection.get(collectionId);
    if (!keys) {
      keys = this.keyring.keys(collectionId).catch(() => null);
      this.keysByCollection.set(collectionId, keys);
    }
    return keys;
  }
}

/**
 * Read-only scan that lists undecryptable and missing chunks per collection, with the stage each failure died at.
 * It reports chunk ids, stages, counts and key fingerprints only: no plaintext, no key bytes and no file names.
 * Plaintext is discarded as soon as it is checked.
 */
export class ChunkIntegrityScanner {
  constructor(
    private readonly repository:ChunkIntegrityRepository,
    private readonly store:Pick<Store, 'storedSize' | 'getBounded'>,
    private readonly keyring:KeySource,
    private readonly crypto:ChunkDecryptor = defaultChunkCrypto,
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
    if (query.diagnose !== undefined) {
      if (query.diagnose !== '1' && query.diagnose !== '0') throw new ChunkIntegrityQueryError('diagnose must be 1 or 0');
      options.diagnose = query.diagnose === '1';
    }
    return options;
  }

  /** `limit` caps the chunks scanned per collection. `diagnose` adds the cross-collection key probe for aead failures. */
  async scan(options:ChunkIntegrityScanOptions = {}):Promise<ChunkIntegrityScanReport> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const probe = options.diagnose ? new KeyOpenProbe(this.repository, this.keyring, this.crypto) : undefined;
    const collections:CollectionChunkIntegrity[] = [];
    for (const collectionId of await this.repository.collectionIds(options.collectionId)) {
      collections.push(await this.scanCollection(collectionId, limit, probe));
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

  private async scanCollection(collectionId:string, limit:number, probe?:KeyOpenProbe):Promise<CollectionChunkIntegrity> {
    const result:CollectionChunkIntegrity = { collectionId, keyFingerprint: null, chunksScanned: 0, undecryptable: [], failures: [], missingBlob: [], errors: 0 };
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
      const checks = await this.mapBounded(page, chunk => this.check(collectionId, chunk, keys));
      for (const [index, check] of checks.entries()) {
        result.chunksScanned += 1;
        if (check.outcome === 'failed') {
          const failure:ChunkFailure = { ...check.failure };
          if (probe && failure.stage === 'aead' && check.envelope && probe.reserve()) {
            failure.opensWith = await probe.findOpener(collectionId, failure.chunkId, check.envelope);
          }
          result.undecryptable.push(failure.chunkId);
          result.failures.push(failure);
        }
        else if (check.outcome === 'missingBlob') result.missingBlob.push(page[index].id);
        else if (check.outcome === 'error') result.errors += 1;
      }
      if (page.length < pageSize) break;
    }
    result.undecryptable.sort();
    result.failures.sort((a, b) => (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
    result.missingBlob.sort();
    return result;
  }

  /** Reads the blob and classifies it. Never throws. Plaintext is zeroed before this returns. */
  private async check(collectionId:string, chunk:ScannedChunkRow, keys:CollectionKeys):Promise<ChunkCheck> {
    let stored:Uint8Array;
    try {
      if (await this.store.storedSize(collectionId, chunk.id) === undefined) return { outcome: 'missingBlob' };
      stored = await this.store.getBounded(collectionId, chunk.id, this.crypto.maxEncryptedChunkBytes(chunk.size), chunk.storedSize);
    } catch {
      return { outcome: 'error' };
    }
    return this.classify(chunk, keys, stored);
  }

  /** Runs the same steps as decryptAndVerifyChunk, one at a time, so each failure reports its stage. Never throws. */
  private async classify(chunk:ScannedChunkRow, keys:CollectionKeys, stored:Uint8Array):Promise<ChunkCheck> {
    const failed = (stage:ChunkFailureStage, extra?:{ plainBytes?:number; envelope?:Envelope }):ChunkCheck => ({
      outcome: 'failed',
      failure: { chunkId: chunk.id, stage, ...(extra?.plainBytes === undefined ? {} : { plainBytes: extra.plainBytes }) },
      envelope: extra?.envelope,
    });

    let envelope:unknown;
    try { envelope = JSON.parse(Buffer.from(stored).toString('utf8')) } catch { return failed('envelope_parse') }
    if (!isEnvelope(envelope)) return failed('envelope_parse');

    let compressed:Uint8Array;
    try { compressed = await this.crypto.decrypt(envelope, keys.data, aadFor(chunk.id)) } catch { return failed('aead', { envelope }) }

    let plain:Buffer;
    try {
      plain = (zlib as any).zstdDecompressSync(Buffer.from(compressed), { maxOutputLength: MAX_PLAIN_BYTES }) as Buffer;
    } catch { return failed('decompress') }
    try {
      if (plain.length !== chunk.size) return failed('size_mismatch', { plainBytes: plain.length });
      if (this.crypto.chunkId(plain, keys.dedup) !== chunk.id) return failed('identity_mismatch');
      return { outcome: 'healthy' };
    } finally {
      plain.fill(0);
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
