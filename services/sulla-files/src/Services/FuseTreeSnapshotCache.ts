// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FuseTreeRepository } from '../Repositories/FuseTreeRepository.js';

export interface FuseTreeSnapshot { body:Buffer; revision:string }

/**
 * Caches one serialized mount tree per area, keyed by the database-owned change marker. Most
 * FUSE lookups pay for a scalar revision read and receive 304 rather than rebuilding and
 * transferring the complete multi-megabyte tree every second. Concurrent misses share one load.
 */
export class FuseTreeSnapshotCache {
  private readonly snapshots = new Map<string, FuseTreeSnapshot>();
  private readonly pending = new Map<string, Promise<FuseTreeSnapshot>>();

  constructor(private readonly tree:Pick<FuseTreeRepository, 'revision' | 'snapshot'>, private readonly userId:string) {}

  revision():Promise<string> { return this.tree.revision() }

  async load(area = ''):Promise<FuseTreeSnapshot> {
    const revision = await this.tree.revision();
    const cached = this.snapshots.get(area); if (cached?.revision === revision) return cached;
    const pending = this.pending.get(area); if (pending) return pending;
    const request = this.build(area).finally(() => { this.pending.delete(area) });
    this.pending.set(area, request);
    return request;
  }

  private async build(area:string):Promise<FuseTreeSnapshot> {
    const rows = await this.tree.snapshot(area, this.userId);
    // The mount serves exactly one collection at its root: the owner's home.
    for (const row of rows.collections) row.tree_path = '';
    const root = rows.collections[0];
    const snapshot = { body: Buffer.from(JSON.stringify({ rootCollectionId: root?.id ?? null, collections: rows.collections, files: rows.files, folders: rows.folders })), revision: rows.revision };
    this.snapshots.set(area, snapshot); return snapshot;
  }
}
