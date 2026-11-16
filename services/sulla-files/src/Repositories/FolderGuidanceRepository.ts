// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Candidate rows /v1/folders/where ranks; ranking needs candidates, not every folder. */
const FOLDER_WHERE_CANDIDATES = 2000;

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

/** Folder rows and the description / naming guidance that tells people and agents where files go. */
export class FolderGuidanceRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** One keyset page of live folders (callers ask for page size + 1 to detect another page). */
  async page(collectionId:string, after:string, limit:number):Promise<any[]> {
    return (await this.db.query("SELECT id,path,operation_revision::text AS revision,description,naming_hint,(description LIKE 'Created by % — needs description') AS needs_description FROM file_folders WHERE collection_id=$1 AND deleted_at IS NULL AND path>$2 ORDER BY path LIMIT $3", [collectionId, after, limit])).rows;
  }

  /** Described collection roots, in explorer order. */
  async describedRoots(limit:number):Promise<any[]> {
    return (await this.db.query(`SELECT id AS collection_id,'' AS path,name,description,naming_hint FROM collections WHERE published=TRUE AND legacy_source=FALSE AND description IS NOT NULL ORDER BY explorer_path LIMIT $1`, [limit])).rows;
  }

  /** Described folders outside secret-looking paths, in explorer order. */
  async describedFolders(limit:number):Promise<any[]> {
    return (await this.db.query(`SELECT f.collection_id,f.path,c.name,f.description,f.naming_hint FROM file_folders f JOIN collections c ON c.id=f.collection_id WHERE f.deleted_at IS NULL AND f.description IS NOT NULL AND lower(f.path) !~ '(^|/)(master[.]key|wallet|vault|vaults)($|/)' ORDER BY c.explorer_path,f.path LIMIT $1`, [limit])).rows;
  }

  async rootCandidates():Promise<any[]> {
    return (await this.db.query(`SELECT id AS collection_id,'' AS path,name,description,naming_hint FROM collections WHERE published=TRUE AND legacy_source=FALSE AND description IS NOT NULL LIMIT ${FOLDER_WHERE_CANDIDATES}`)).rows;
  }

  /** Described folders matching at least one LIKE pattern (all of them when there are no patterns), capped. */
  async folderCandidates(patterns:string[]):Promise<any[]> {
    return (await this.db.query(`SELECT f.collection_id,f.path,c.name,f.description,f.naming_hint FROM file_folders f JOIN collections c ON c.id=f.collection_id WHERE f.deleted_at IS NULL AND f.description IS NOT NULL AND lower(f.path) !~ '(^|/)(master[.]key|wallet|vault|vaults)($|/)' AND (cardinality($1::text[])=0 OR lower(c.name||' '||f.path||' '||f.description||' '||COALESCE(f.naming_hint,'')) LIKE ANY($1::text[])) ORDER BY f.path LIMIT ${FOLDER_WHERE_CANDIDATES}`, [patterns])).rows;
  }

  async liveFolder(folderId:string):Promise<any> {
    return (await this.db.query('SELECT * FROM file_folders WHERE id=$1 AND deleted_at IS NULL', [folderId])).rows[0];
  }

  async describeFolder(folderId:string, description:string | null, namingHint:string | null):Promise<any> {
    return (await this.db.query('UPDATE file_folders SET description=$2,naming_hint=$3,updated_at=NOW() WHERE id=$1 RETURNING id AS "folderId",collection_id AS "collectionId",path,operation_revision::text AS revision,description,naming_hint AS "namingHint"', [folderId, description, namingHint])).rows[0];
  }

  /** Inside the create-folder transaction: sets the new folder's guidance. */
  async describeFolderAt(client:Queryable, collectionId:string, folderPath:string, description:string, namingHint:string | null):Promise<void> {
    await client.query('UPDATE file_folders SET description=$3,naming_hint=$4,updated_at=NOW() WHERE collection_id=$1 AND path=$2', [collectionId, folderPath, description, namingHint]);
  }

  /** Inside the create-folder transaction: marks undescribed folders on the path as needing a description. */
  async markUndescribed(client:Queryable, collectionId:string, paths:string[], fallback:string):Promise<void> {
    await client.query(`UPDATE file_folders SET description=$3,updated_at=NOW() WHERE collection_id=$1 AND path=ANY($2::text[]) AND description IS NULL`, [collectionId, paths, fallback]);
  }
}
