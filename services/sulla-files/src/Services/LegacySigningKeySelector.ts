// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHmac } from 'node:crypto';

import { defaultChunkCrypto, type ChunkCrypto } from '../crypto.js';
import { LegacyKeyProbeRepository } from '../Repositories/LegacyKeyProbeRepository.js';

import type { CapabilityKeyCandidates, SigningKey } from '../CapabilityKeyCandidates.js';
import type { Store } from '../store.js';
import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * Picks the signing key a native collection's legacy content keys were derived from.
 *
 * With one candidate it is returned untouched (no I/O). With the pre-#2369 key also in play,
 * each candidate's derived data/dedup keys are tried against a few stored chunks of the
 * collection; the first that decrypts and verifies a chunk wins. A collection with no
 * readable chunk keeps the current key, exactly as before.
 */
export class LegacySigningKeySelector {
  private static readonly SAMPLE = 3;

  constructor(
    private readonly store:Pick<Store, 'storedSize' | 'getBounded'>,
    private readonly chunks = new LegacyKeyProbeRepository(),
    private readonly crypto:Pick<ChunkCrypto, 'maxEncryptedChunkBytes' | 'decryptAndVerifyChunk'> = defaultChunkCrypto,
  ) {}

  static dataKey(key:SigningKey, collectionId:string):Buffer { return createHmac('sha256', key).update(`sulla:files:data-key:v1:${ collectionId }`).digest() }

  static dedupKey(key:SigningKey, collectionId:string):Buffer { return createHmac('sha256', key).update(`sulla:files:dedup-key:v1:${ collectionId }`).digest() }

  async select(client:Queryable, collectionId:string, candidates:CapabilityKeyCandidates):Promise<SigningKey> {
    if (!candidates.hasPrevious) return candidates.current;
    const samples = await this.chunks.sampleChunks(client, collectionId, LegacySigningKeySelector.SAMPLE);
    for (const sample of samples) {
      const envelope = await this.read(collectionId, sample.id, sample.size);
      if (!envelope) continue;
      for (const key of candidates.all) if (await this.decrypts(envelope, key, collectionId, sample)) return key;
    }
    return candidates.current;
  }

  private async read(collectionId:string, id:string, size:number):Promise<Buffer | undefined> {
    try {
      const max = this.crypto.maxEncryptedChunkBytes(size);
      const stored = await this.store.storedSize(collectionId, id);
      if (stored === undefined || stored < 1 || stored > max) return undefined;
      return await this.store.getBounded(collectionId, id, max, stored);
    } catch { return undefined }
  }

  private async decrypts(envelope:Buffer, key:SigningKey, collectionId:string, sample:{ id:string; size:number }):Promise<boolean> {
    const data = LegacySigningKeySelector.dataKey(key, collectionId); const dedup = LegacySigningKeySelector.dedupKey(key, collectionId);
    try {
      (await this.crypto.decryptAndVerifyChunk(envelope, data, dedup, sample.id, sample.size)).fill(0);
      return true;
    } catch { return false } finally { data.fill(0); dedup.fill(0) }
  }
}
