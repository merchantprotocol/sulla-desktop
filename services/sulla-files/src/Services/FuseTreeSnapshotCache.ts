// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Config } from '../config.js';
import type { FuseTreeRepository } from '../Repositories/FuseTreeRepository.js';

export interface FuseTreeSnapshot { body:Buffer; revision:string }

/**
 * Caches one serialized mount tree per area, keyed by the database-owned change marker. Most
 * FUSE lookups pay for a scalar revision read and receive 304 rather than rebuilding and
 * transferring the complete multi-megabyte tree every second. Concurrent misses share one load.
 * The owner is read live (Vault unlock changes it) and is part of the cache key, so a tree built
 * for the pre-unlock sentinel is never served to the adopted principal at the same revision.
 */
export class FuseTreeSnapshotCache {
  private readonly snapshots = new Map<string, FuseTreeSnapshot>();
  private readonly pending = new Map<string, Promise<FuseTreeSnapshot>>();

  constructor(private readonly tree:Pick<FuseTreeRepository, 'revision' | 'snapshot'>, private readonly owner:Readonly<Pick<Config, 'userId'>>) {}

  revision():Promise<string> { return this.tree.revision() }

  async load(area = ''):Promise<FuseTreeSnapshot> {
    const revision = await this.tree.revision();
    const userId = this.owner.userId;
    const key = `${ userId }\u0000${ area }`;
    const cached = this.snapshots.get(key); if (cached?.revision === revision) return cached;
    const pending = this.pending.get(key); if (pending) return pending;
    const request = this.build(key, area, userId).finally(() => { this.pending.delete(key) });
    this.pending.set(key, request);
    return request;
  }

  private async build(key:string, area:string, userId:string):Promise<FuseTreeSnapshot> {
    const rows = await this.tree.snapshot(area, userId);
    // The mount serves exactly one collection at its root: the owner's home.
    for (const row of rows.collections) row.tree_path = '';
    const root = rows.collections[0];
    const snapshot = { body: Buffer.from(JSON.stringify({ rootCollectionId: root?.id ?? null, collections: rows.collections, files: rows.files, folders: rows.folders })), revision: rows.revision };
    // Only the current owner's tree is worth keeping.
    for (const stale of this.snapshots.keys()) if (stale !== key && !stale.startsWith(`${ userId }\u0000`)) this.snapshots.delete(stale);
    this.snapshots.set(key, snapshot); return snapshot;
  }
}
