// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VectorStateRepository } from '../Repositories/VectorStateRepository.js';

import type pg from 'pg';

const NEGATIVE_TTL_MS = 15_000;

interface Cached { value:boolean; checkedAt:number }

/** One cached yes/no probe: a "yes" is kept for good, a "no" is re-checked after 15 s. */
class CachedProbe {
  private cached?:Cached;
  constructor(private readonly read:() => Promise<boolean>, private readonly now:() => number) {}

  async get():Promise<boolean> {
    if (this.cached?.value || (this.cached && this.now() - this.cached.checkedAt < NEGATIVE_TTL_MS)) return this.cached.value;
    const value = await this.read();
    this.cached = { value, checkedAt: this.now() };
    return value;
  }
}

/**
 * Whether semantic search can use pgvector. `tableExists`: new embeddings should also be
 * written to the halfvec table. `searchReady`: the backfill finished, so search may read
 * halfvec and JSON copies may be dropped. Both answers are cached per instance.
 */
export class VectorCapability {
  private readonly table:CachedProbe;
  private readonly ready:CachedProbe;

  constructor(repository:VectorStateRepository, now:() => number = Date.now) {
    this.table = new CachedProbe(() => repository.tableExists(), now);
    this.ready = new CachedProbe(() => repository.searchReady(), now);
  }

  static forPool(db:pg.Pool):VectorCapability { return new VectorCapability(new VectorStateRepository(db)) }

  tableExists():Promise<boolean> { return this.table.get() }
  searchReady():Promise<boolean> { return this.ready.get() }
}
