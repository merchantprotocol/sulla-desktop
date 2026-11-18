// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesIdentity } from '../auth.js';
import type { StoredNamespaceRepository } from '../Repositories/StoredNamespaceRepository.js';
import type pg from 'pg';

export class StoredNamespaceConflict extends Error { status = 409 }

/**
 * Serialises and checks stored-namespace changes in one collection.
 *
 * Every stored namespace mutation takes the transaction-scoped collection lock before any
 * file/folder row lock. PostgreSQL cannot express the file-versus-folder prefix invariant as
 * a normal unique constraint, so the collection lock (shared for one path, exclusive for broad
 * changes) plus per-path slot locks are the serialization point for checking and changing paths.
 */
export class StoredNamespaceGuard {
  constructor(private readonly repository:StoredNamespaceRepository) {}

  static parentPaths(path:string):string[] {
    const parts = path.split('/');
    return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
  }

  async lock(client:pg.PoolClient, rawCollectionId:string, scopedPath?:string):Promise<void> {
    // The trigger builds its key from the uuid's canonical (lowercase) text; match it.
    const collectionId = rawCollectionId.toLowerCase();
    const collectionKey = `stored-namespace:${ collectionId }`;
    if (scopedPath === undefined) {
      // Broad namespace edits (rename/move/delete, sync reconciliation) retain the
      // exclusive gate and therefore exclude every path-scoped create below.
      await this.repository.lockExclusive(client, collectionKey);
      return;
    }
    // A scoped create shares the collection gate with other scoped creates and excludes broad
    // namespace mutations and unscoped writers (both take it exclusively). Ancestor slots are
    // shared and the target slot is exclusive, which catches exact-path and file-vs-folder
    // prefix races at any depth while siblings in one directory proceed together. Every
    // transaction acquires its sorted ancestor/target keys in the same order.
    //
    // The namespace trigger (migrations 027/067) would otherwise take the collection key
    // exclusively for every row inserted here, upgrading this shared lock and deadlocking two
    // concurrent creates. Declaring the scope tells the trigger these locks are already held for
    // the target row and its parent folders, so it takes none; any other row it still gates
    // with the exclusive key. Never insert or move a file/folder outside the declared scope
    // after a scoped lock: lock broadly (no path) for that transaction instead.
    // One round trip (migration 067's files_lock_namespace_scope) takes the collection key
    // shared, the ancestor slots shared and the target slot exclusive, then declares the scope.
    await this.repository.lockScope(client, collectionId, scopedPath);
  }

  /**
   * Scoped locks for several paths in one transaction (a replace touches its target and its source).
   * The paths are sorted and de-duplicated so every transaction takes the same keys in the same
   * order: two crossed replaces (a over b, b over a) then queue on the first shared key instead of
   * each holding one exclusive slot the other waits for.
   */
  async lockPaths(client:pg.PoolClient, rawCollectionId:string, scopedPaths:string[]):Promise<void> {
    for (const path of [...new Set(scopedPaths)].sort()) await this.lock(client, rawCollectionId, path);
  }

  async assertFilePath(client:pg.PoolClient, collectionId:string, path:string, sameFileId?:string):Promise<void> {
    const occupied = await this.repository.findFileConflict(client, collectionId, path, StoredNamespaceGuard.parentPaths(path), sameFileId);
    if (occupied !== undefined) throw new StoredNamespaceConflict(`A file already occupies ${ occupied }, so ${ path } cannot be stored there.`);
    if (await this.repository.folderExists(client, collectionId, path)) throw new StoredNamespaceConflict(`A folder already exists at ${ path }.`);
  }

  async assertFolderPath(client:pg.PoolClient, collectionId:string, path:string):Promise<void> {
    const occupied = await this.repository.findFileOnPrefixes(client, collectionId, [...StoredNamespaceGuard.parentPaths(path), path]);
    if (occupied !== undefined) throw new StoredNamespaceConflict(`A file already occupies ${ occupied }, so ${ path } cannot be a folder.`);
  }

  async ensureFileParents(client:pg.PoolClient, collectionId:string, filePath:string, actor:FilesIdentity):Promise<void> {
    await this.insertMissingFolders(client, collectionId, StoredNamespaceGuard.parentPaths(filePath), actor);
  }

  async ensureFolder(client:pg.PoolClient, collectionId:string, folderPath:string, actor:FilesIdentity):Promise<void> {
    await this.assertFolderPath(client, collectionId, folderPath);
    await this.insertMissingFolders(client, collectionId, [...StoredNamespaceGuard.parentPaths(folderPath), folderPath], actor);
  }

  /**
   * Inserts only the folders that do not exist yet. A folder INSERT fires the namespace
   * journal and tree-revision triggers even when ON CONFLICT then skips it, so inserting
   * every ancestor on every file write cost ~13 trigger runs per file. One indexed lookup
   * finds the missing ones (normally none) and one multi-row insert creates them.
   */
  private async insertMissingFolders(client:pg.PoolClient, collectionId:string, paths:string[], actor:FilesIdentity):Promise<void> {
    const createdByType = actor.kind === 'capability' ? 'agent-or-device' : 'user';
    const description = actor.agentId || actor.jobId ? `Created by ${ actor.agentId ?? actor.jobId } on ${ new Date().toISOString().slice(0, 10) } — needs description` : null;
    if (!paths.length) return;
    const have = await this.repository.existingFolders(client, collectionId, paths);
    const missing = paths.filter(path => !have.has(path));
    if (!missing.length) return;
    // Parents first: callers pass them shallowest-first, and unnest keeps that order.
    await this.repository.insertFolders(client, collectionId, missing, createdByType, actor.userId, description);
  }
}
