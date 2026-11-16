// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/**
 * The stored-namespace SQL: transaction-scoped advisory locks and the file/folder slot probes
 * every create runs. Always called with the open transaction's client.
 */
export class StoredNamespaceRepository {
  /** Exclusive transaction advisory lock on `key`. */
  async lockExclusive(client:pg.PoolClient, key:string):Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  }

  /** Shared transaction advisory lock on `key`. */
  async lockShared(client:pg.PoolClient, key:string):Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [key]);
  }

  /**
   * Records "<collection id>:<path>" in the transaction-local `sulla_files.namespace_scopes`
   * list the namespace trigger reads (migration 067). It resets at COMMIT/ROLLBACK.
   */
  async declareScope(client:pg.PoolClient, scope:string):Promise<void> {
    await client.query(`SELECT set_config('sulla_files.namespace_scopes',
      concat_ws(E'\n',NULLIF(current_setting('sulla_files.namespace_scopes',TRUE),''),$1::text),TRUE)`, [scope]);
  }

  /** Transaction advisory lock on `key`, exclusive or shared. */
  async lockPath(client:pg.PoolClient, key:string, shared:boolean):Promise<void> {
    const acquire = shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
    await client.query(`SELECT ${ acquire }(hashtextextended($1,0))`, [key]);
  }

  /** The shallowest file at, above or below `path` (other than `sameFileId`), if any. */
  async findFileConflict(client:pg.PoolClient, collectionId:string, path:string, parents:string[], sameFileId?:string):Promise<string | undefined> {
    const file = await client.query(`SELECT path FROM files
    WHERE collection_id=$1 AND (path=$2 OR path=ANY($3::text[]) OR starts_with(path,$2||'/'))
      AND ($4::uuid IS NULL OR id<>$4::uuid)
    ORDER BY length(path),path LIMIT 1`, [collectionId, path, parents, sameFileId ?? null]);
    return file.rowCount ? file.rows[0].path : undefined;
  }

  async folderExists(client:pg.PoolClient, collectionId:string, path:string):Promise<boolean> {
    const folder = await client.query('SELECT path FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1', [collectionId, path]);
    return Boolean(folder.rowCount);
  }

  /** The shallowest file sitting exactly on one of `prefixes`, if any. */
  async findFileOnPrefixes(client:pg.PoolClient, collectionId:string, prefixes:string[]):Promise<string | undefined> {
    const file = await client.query(`SELECT path FROM files
    WHERE collection_id=$1 AND path=ANY($2::text[])
    ORDER BY length(path),path LIMIT 1`, [collectionId, prefixes]);
    return file.rowCount ? file.rows[0].path : undefined;
  }

  /** Which of `paths` already exist as folders. Bounded by the caller's path list (one path's ancestors). */
  async existingFolders(client:pg.PoolClient, collectionId:string, paths:string[]):Promise<Set<string>> {
    const existing = await client.query('SELECT path FROM file_folders WHERE collection_id=$1 AND path=ANY($2::text[])', [collectionId, paths]);
    return new Set(existing.rows.map((row:{ path:string }) => row.path));
  }

  /** Inserts `paths` in the given order (parents first); existing folders are skipped. */
  async insertFolders(client:pg.PoolClient, collectionId:string, paths:string[], createdByType:string, createdById:string, description:string | null):Promise<void> {
    await client.query(`INSERT INTO file_folders(collection_id,path,created_by_type,created_by_id,description)
    SELECT $1,p,$3,$4,$5 FROM unnest($2::text[]) WITH ORDINALITY AS t(p,o) ORDER BY o
    ON CONFLICT(collection_id,path) DO NOTHING`,
    [collectionId, paths, createdByType, createdById, description]);
  }
}
