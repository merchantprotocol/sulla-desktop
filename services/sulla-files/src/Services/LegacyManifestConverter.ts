// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, timingSafeEqual } from 'node:crypto';

import { chunkId, decryptChunk, encryptChunk } from '../crypto.js';
import { LegacyChunkSource } from './LegacyChunkSource.js';

import type { Store } from '../store.js';

export interface LegacyKeys { data: Buffer; dedup: Buffer }
export interface ConvertedManifest { hash: string; ids: string[]; totalSize: number; plaintextHash: string; chunks: Map<string, { size: number; storedSize: number }> }

export interface LegacyManifestInput {
  collectionId:       string;
  chunkIds:           string[];
  totalSize:          number;
  sourceRoot:         string;
  sourceKeys:         LegacyKeys;
  shadowKeys:         LegacyKeys;
  shadowCollectionId: string;
}

/**
 * Re-encrypts one legacy manifest into its native shadow collection. Every source chunk
 * is authenticated (AEAD + keyed identity), every shadow chunk is read back and verified,
 * and plaintext is zeroed as soon as it is no longer needed.
 */
export class LegacyManifestConverter {
  constructor(private readonly source:LegacyChunkSource, private readonly store:Store) {}

  async convert(input:LegacyManifestInput):Promise<ConvertedManifest> {
    if (!Number.isSafeInteger(input.totalSize) || input.totalSize < 0) throw new Error('Legacy Files manifest has an invalid size');
    const outputIds:string[] = []; const chunks = new Map<string, { size: number; storedSize: number }>(); const whole = createHash('sha256'); let total = 0;
    for (const rawId of input.chunkIds) {
      const sourceId = LegacyChunkSource.validId(String(rawId), LegacyChunkSource.CHUNK, 'chunk');
      const encrypted = await this.source.read(input.sourceRoot, input.collectionId, sourceId);
      const plain = Buffer.from(await decryptChunk(encrypted, input.sourceKeys.data, sourceId));
      try {
        const expected = Buffer.from(sourceId, 'hex'); const actual = Buffer.from(chunkId(plain, input.sourceKeys.dedup), 'hex');
        if (!timingSafeEqual(expected, actual)) throw new Error('Legacy Files chunk identity verification failed');
        total += plain.length; if (!Number.isSafeInteger(total) || total > input.totalSize) throw new Error('Legacy Files manifest size verification failed');
        whole.update(plain);
        const outputId = chunkId(plain, input.shadowKeys.dedup); outputIds.push(outputId);
        if (!await this.store.has(input.shadowCollectionId, outputId)) await this.store.put(input.shadowCollectionId, outputId, await encryptChunk(plain, input.shadowKeys.data, outputId));
        const stored = await this.store.get(input.shadowCollectionId, outputId);
        const verified = Buffer.from(await decryptChunk(stored, input.shadowKeys.data, outputId));
        try {
          if (!timingSafeEqual(plain, verified) || chunkId(verified, input.shadowKeys.dedup) !== outputId) throw new Error('Native shadow chunk verification failed');
          chunks.set(outputId, { size: verified.length, storedSize: stored.length });
        } finally { verified.fill(0) }
      } finally { plain.fill(0); encrypted.fill(0) }
    }
    if (total !== input.totalSize) throw new Error('Legacy Files manifest size verification failed');
    const hash = createHash('sha256').update(JSON.stringify({ ids: outputIds, size: total })).digest('hex');
    return { hash, ids: outputIds, totalSize: total, plaintextHash: whole.digest('hex'), chunks };
  }
}
