// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { defaultChunkCrypto, type ChunkCrypto } from '../crypto.js';
import type { FilesKeyring } from '../keyring.js';
import type { Store } from '../store.js';
import type { ChunkCacheRepository } from '../Repositories/ChunkCacheRepository.js';
import type { CloudChunkSource } from './types.js';

/** Restores an evicted chunk from its cloud copy, once per chunk however many readers wait on it. */
export class ChunkHydrator {
  private readonly flights = new Map<string, Promise<Buffer>>();
  constructor(
    private readonly cache:ChunkCacheRepository,
    private readonly store:Store,
    private readonly keyring:FilesKeyring,
    private readonly source:CloudChunkSource,
    private readonly crypto:Pick<ChunkCrypto, 'chunkId' | 'encryptChunk'> = defaultChunkCrypto,
  ) {}
  hydrate(collectionId:string, id:string):Promise<Buffer> {
    const flightKey = `${collectionId}:${id}`;
    const current = this.flights.get(flightKey); if (current) return current;
    const flight = this.run(collectionId, id).finally(() => this.flights.delete(flightKey));
    this.flights.set(flightKey, flight); return flight;
  }
  private async run(collectionId:string, id:string):Promise<Buffer> {
    const state = await this.cache.state(collectionId, id);
    if (state !== 'evicted') throw Object.assign(new Error('Local chunk is unavailable'), { code: 'ENOENT' });
    // Throws FILE_OFFLINE when the cloud copy is unreachable.
    const plain = await this.source.fetchPlain(collectionId, id);
    const keys = await this.keyring.keys(collectionId);
    try {
      if (this.crypto.chunkId(plain, keys.dedup) !== id) throw Object.assign(new Error('Hydrated chunk identity mismatch'), { code: 'FILE_INTEGRITY' });
      const encrypted = await this.crypto.encryptChunk(plain, keys.data, id);
      await this.store.put(collectionId, id, encrypted);
      await this.cache.markHydrated(collectionId, id, encrypted.byteLength);
      return encrypted;
    } finally { plain.fill(0) }
  }
}
