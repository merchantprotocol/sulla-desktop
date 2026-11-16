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
 * a normal unique constraint, so the shared lock is the serialization point for checking and
 * changing paths.
 */
export class StoredNamespaceGuard {
  constructor(private readonly repository:StoredNamespaceRepository) {}

  static parentPaths(path:string):string[] {
    const parts = path.split('/');
    return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
  }

  async lock(client:pg.PoolClient, collectionId:string, scopedPath?:string):Promise<void> {
    const collectionKey = `stored-namespace:${ collectionId }`;
    if (scopedPath === undefined) {
      // Broad namespace edits (rename/move/delete, sync reconciliation) retain the
      // exclusive gate and therefore exclude every path-scoped create below.
      await this.repository.lockExclusive(client, collectionKey);
      return;
    }
    // A scoped create takes the collection gate exclusively. The database's
    // namespace trigger also takes this advisory key exclusively while inserting
    // file/folder rows, so taking it shared here would make concurrent writers
    // deadlock while upgrading their transaction locks in the trigger. Ancestor
    // file slots are shared; the target slot is exclusive. This catches exact-path
    // and file-vs-folder prefix races even for deep paths.
    // Every transaction acquires the same sorted set of ancestor/target keys.
    await this.repository.lockExclusive(client, collectionKey);
    const ancestors = new Set(StoredNamespaceGuard.parentPaths(scopedPath));
    const paths = [...new Set([...ancestors, scopedPath])].sort();
    for (const path of paths) {
      await this.repository.lockPath(client, `stored-namespace-path:${ collectionId }:${ path }`, path !== scopedPath);
    }
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
