// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Reads behind GET /v1/trash: trashed files and top-level folders with their trash receipts and path operations. */
export class TrashListingRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>, private readonly fileColumnsSql:string) {}

  /** Every trashed, unprotected file in the collection, newest first (reviewed unbounded read: one collection's trash). */
  async trashedFiles(collectionId:string):Promise<any[]> {
    return (await this.db.query(`SELECT ${this.fileColumnsSql} FROM files f WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) AND f.collection_id=$1 AND f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC`,[collectionId])).rows;
  }

  /** The latest trash receipt per file whose recorded version is still the file's current one. */
  async fileTrashReceipts(fileIds:string[]):Promise<any[]> {
    return (await this.db.query(`SELECT DISTINCT ON (r.file_id) r.* FROM files_database_operation_receipts r
      JOIN files f ON f.id=r.file_id AND f.current_version_id::text=r.after_state->>'versionId'
      WHERE r.file_id=ANY($1) AND r.action='trash' ORDER BY r.file_id,r.created_at DESC`,[fileIds])).rows;
  }

  async pathOperations(operationIds:string[]):Promise<any[]> {
    return (await this.db.query('SELECT operation_id,state,plan,last_error FROM files_path_operations WHERE operation_id=ANY($1)',[operationIds])).rows;
  }

  /** Trashed folders not inside another trashed folder (reviewed unbounded read: one collection's trash). */
  async trashedTopFolders(collectionId:string):Promise<any[]> {
    return (await this.db.query(`SELECT * FROM file_folders f WHERE f.collection_id=$1 AND f.deleted_at IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM file_folders p WHERE p.collection_id=f.collection_id AND p.deleted_at IS NOT NULL AND p.id<>f.id AND starts_with(f.path,p.path||'/')) ORDER BY f.deleted_at DESC,f.path`,[collectionId])).rows;
  }

  /** Completed folder trash receipts for these source paths, newest first. */
  async folderTrashReceipts(collectionId:string, sources:string[]):Promise<any[]> {
    return (await this.db.query(`SELECT * FROM files_database_operation_receipts r WHERE r.collection_id=$1 AND r.action='trash' AND r.state='completed'
      AND r.folder_plan->>'source'=ANY($2) ORDER BY r.created_at DESC`,[collectionId,sources])).rows;
  }
}
