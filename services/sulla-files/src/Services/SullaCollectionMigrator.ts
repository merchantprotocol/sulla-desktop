// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Config } from '../config.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { MigratedRowKind, SullaCollectionMigrationRepository } from '../Repositories/SullaCollectionMigrationRepository.js';
import type pg from 'pg';

export interface SullaCollectionMigrationSummary { moved:number; collisions:number }

/**
 * Moves every folder and file of the former Sulla system collection into the owner's home collection.
 * Content is not re-encrypted: each version keeps its chunk_collection_id, so the Sulla collection
 * (and its key) must stay published. It is emptied and renamed, never deleted. Idempotent: a
 * finished migration finds nothing left to move, and a resumed one reuses recorded folder targets.
 */
export class SullaCollectionMigrator {
  constructor(private readonly repository:SullaCollectionMigrationRepository, private readonly transactions:TransactionRunner) {}

  async migrate(config:Config):Promise<SullaCollectionMigrationSummary> {
    const source = await this.repository.findSullaCollection();
    if (!source) return { moved: 0, collisions: 0 };
    const home = await this.repository.findHome(source.owner_user_id);
    if (!home) throw new Error('Cannot migrate the Sulla collection without an owner home collection');
    await this.repository.ensurePathTable();
    const summary = { moved: 0, collisions: 0 };
    for (const folder of await this.repository.folderIds(source.id)) await this.move('folder', folder.id, source, home, config, summary);
    for (const file of await this.repository.fileIds(source.id)) await this.move('file', file.id, source, home, config, summary);
    const left = await this.repository.remainingRows(source.id);
    if (left) throw new Error(`Sulla migration verification failed: ${ left } rows remain`);
    if (source.explorer_path !== '.sulla-retired') await this.repository.retire(source.id);
    if (summary.moved || summary.collisions) console.log(`[SullaFiles] Sulla migration complete: moved=${ summary.moved } collisions=${ summary.collisions }`);
    return summary;
  }

  private async move(kind:MigratedRowKind, rowId:string, source:any, home:any, config:Config, summary:SullaCollectionMigrationSummary):Promise<void> {
    await this.transactions.run('sulla-collection-migration', async client => {
      await this.repository.lockNamespaces(client, [source.id, home.id]);
      const current = await this.repository.lockRow(client, kind, rowId);
      if (current?.collection_id !== source.id) return;
      const recorded = await this.repository.recordedTarget(client, source.id, current.path);
      const parents = await this.repository.nearestMigratedParent(client, source.id, current.path);
      const proposed = recorded ?? (parents ? parents.target_path + current.path.slice(parents.source_path.length) : current.path);
      const target = recorded ? { path: recorded, collision: recorded !== current.path } : await this.freePath(client, home.id, proposed);
      if (kind === 'folder') await this.repository.recordTarget(client, source.id, current.path, target.path);
      await this.repository.moveRow(client, kind, current.id, home.id, target.path);
      if (kind === 'file') {
        await this.repository.journalRename(client, home.id, current.id, current.current_version_id);
        await this.repository.auditMove(client, config.userId, current.id, current.current_version_id, { from: current.path, to: target.path, sourceCollectionId: source.id });
        summary.moved++;
      }
      if (target.collision) { summary.collisions++; console.warn(`[SullaFiles] Sulla migration collision: ${ current.path } -> ${ target.path }`) }
    });
  }

  /** `original`, or the first free "name (migrated N).ext" beside it. */
  private async freePath(client:pg.PoolClient, collectionId:string, original:string):Promise<{ path:string; collision:boolean }> {
    if (!await this.repository.isOccupied(client, collectionId, original)) return { path: original, collision: false };
    const slash = original.lastIndexOf('/'); const leaf = original.slice(slash + 1); const dot = leaf.lastIndexOf('.');
    const split = dot > 0 ? slash + 1 + dot : original.length;
    for (let n = 1; n <= 1000; n++) {
      const candidate = original.slice(0, split) + (n === 1 ? ' (migrated)' : ` (migrated ${ n })`) + original.slice(split);
      if (!await this.repository.isOccupied(client, collectionId, candidate)) return { path: candidate, collision: true };
    }
    throw new Error(`No migration destination is available for ${ original }`);
  }
}
