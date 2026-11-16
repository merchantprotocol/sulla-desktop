// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Read-side SQL over tracked files: the FUSE mount view, stored-version manifests, reveal-original checks, native custody, recents. */
export class TrackedFileRepository {
  constructor(private readonly db:pg.Pool) {}

  /** Every mountable file in the collection (reviewed unbounded read: one mount listing). */
  async mountView(collectionId:string, rootId:string | null):Promise<any[]> {
    return (await this.db.query(`SELECT f.id::text,f.collection_id::text,f.path,f.mime,f.size,f.current_version_id::text AS version_id,
      COALESCE(n.source_hash,c.content_hash,w.content_hash) AS content_hash,
      COALESCE(EXTRACT(EPOCH FROM n.updated_at)*1000,EXTRACT(EPOCH FROM c.created_at)*1000,w.mtime_ms) AS mtime_ms
      FROM files f
      LEFT JOIN files_native_sources n ON n.file_id=f.id AND n.state IN('active','conflict')
      LEFT JOIN files_native_conflicts c ON c.file_id=f.id
      LEFT JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
      WHERE f.collection_id=$1 AND f.deleted_at IS NULL AND (n.file_id IS NOT NULL OR c.file_id IS NOT NULL OR ($2::text IS NOT NULL AND w.root_id=$2))
        AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) ORDER BY f.path`, [collectionId, rootId])).rows;
  }

  async mountRow(fileId:string):Promise<any> {
    return (await this.db.query(`SELECT f.id::text,f.collection_id::text,f.path,f.mime,f.size,f.current_version_id::text AS version_id,
      COALESCE(n.source_hash,c.content_hash,w.content_hash) AS content_hash,
      COALESCE(EXTRACT(EPOCH FROM n.updated_at)*1000,EXTRACT(EPOCH FROM c.created_at)*1000,w.mtime_ms) AS mtime_ms,
      w.root_id,n.source_handle,n.source_revision,c.file_id AS native_conflict_file_id FROM files f
      LEFT JOIN files_native_sources n ON n.file_id=f.id AND n.state IN('active','conflict')
      LEFT JOIN files_native_conflicts c ON c.file_id=f.id
      LEFT JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id
      WHERE f.id=$1 AND f.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)`, [fileId])).rows[0];
  }

  async storedVersion(fileId:string, versionId:string):Promise<{ chunk_collection_id:string; size:string | number; chunk_ids:string[] } | undefined> {
    return (await this.db.query(`SELECT v.chunk_collection_id,v.size,m.chunk_ids FROM file_versions v
      JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.file_id=$2`, [versionId, fileId])).rows[0];
  }

  async revealCandidate(file:{ id:string; collection_id:string; path:string }):Promise<any> {
    return (await this.db.query(`SELECT w.*,r.enabled,r.state,r.mount_path FROM watched_folder_state w
        JOIN file_roots r ON r.id=w.root_id AND r.collection_id=w.collection_id
        WHERE w.file_id=$1 AND w.collection_id=$2 AND w.path=$3`, [file.id,file.collection_id,file.path])).rows[0];
  }

  async revealStillFresh(file:any, row:any, root:{ id:string; path:string }):Promise<boolean> {
    return Boolean((await this.db.query(`SELECT 1 FROM files f JOIN watched_folder_state w ON w.file_id=f.id AND w.collection_id=f.collection_id AND w.path=f.path
            JOIN file_roots r ON r.id=w.root_id AND r.collection_id=w.collection_id
            WHERE f.id=$1 AND f.current_version_id=$2 AND f.operation_revision=$3 AND f.path=$4 AND f.deleted_at IS NULL
              AND w.content_hash=$5 AND w.size=$6 AND w.mtime_ms=$7 AND r.id=$8 AND r.mount_path=$9 AND r.enabled=TRUE
              AND r.state NOT IN('detached','offline','error') AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)`,
    [file.id,file.current_version_id,file.operation_revision,file.path,row.content_hash,row.size,row.mtime_ms,root.id,root.path])).rowCount);
  }

  async rootForCollection(collectionId:string):Promise<any> {
    return (await this.db.query('SELECT * FROM file_roots WHERE collection_id=$1',[collectionId])).rows[0];
  }

  async hasWatchedFiles(collectionId:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM watched_folder_state WHERE collection_id=$1 LIMIT 1',[collectionId])).rowCount);
  }

  async recent(exactPath:string | null, limit:number):Promise<any[]> {
    return (await this.db.query(`SELECT f.id,f.path,f.mime,f.size,f.updated_at,(f.path ILIKE '%conflicted copy%') AS conflict,m.duration_seconds,r.state AS residency_state
      FROM files f
      LEFT JOIN recording_metadata m ON m.file_id=f.id
      LEFT JOIN file_residency r ON r.file_id=f.id
      WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) AND f.deleted_at IS NULL AND ($1::text IS NULL OR f.path=$1) ORDER BY f.updated_at DESC LIMIT $2`, [exactPath, limit])).rows;
  }

  async watchedUnder(collectionId:string, path:string, folder:boolean):Promise<string[]> {
    return (await this.db.query(`SELECT file_id::text FROM watched_folder_state WHERE collection_id=$1 AND (path=$2 OR ($3 AND starts_with(path,$2||'/')))`, [collectionId, path, folder])).rows.map(row => row.file_id);
  }
}
