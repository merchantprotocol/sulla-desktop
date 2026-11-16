// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChunkRegistryRepository } from './Repositories/ChunkRegistryRepository.js';

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

export class UnregisteredChunkError extends Error {
  readonly status = 500;
  readonly code = 'FILES_CHUNK_UNREGISTERED';
  constructor(readonly collectionId:string, readonly missing:readonly string[]) {
    super(`Refusing to record a version whose chunks are not registered (${ missing.length } missing)`);
  }
}

/**
 * The content read path needs a `chunks` row for every chunk a manifest names. A version committed
 * without one is listed but unreadable forever (the build #1 retry bug: a blob left on disk by a
 * rolled-back attempt made the retry skip its row). Writers call this inside their commit
 * transaction, after inserting chunk rows and before the version becomes current, so such a write
 * fails loudly and leaves the previous version current instead of silently breaking the file.
 */
export class ManifestChunkRegistry {
  constructor(private readonly chunks = new ChunkRegistryRepository()) {}

  async assertRegistered(client:Queryable, collectionId:string, chunkIds:readonly string[]):Promise<void> {
    const wanted = [...new Set(chunkIds)];
    if (!wanted.length) return;
    const found = await this.chunks.registeredIds(client, collectionId, wanted);
    const missing = wanted.filter(id => !found.has(id));
    if (missing.length) throw new UnregisteredChunkError(collectionId, missing);
  }
}
