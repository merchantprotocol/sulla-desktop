// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
export type MetadataTable = 'files' | 'file_folders';

/** Free-form metadata on files and folders, with its revision and per-key audit (SQL moved verbatim from app.ts). */
export class FileMetadataRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async liveFileAt(queryable:Queryable, collectionId:string, path:string):Promise<any> {
    return (await queryable.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 AND deleted_at IS NULL', [collectionId, path])).rows[0];
  }

  async liveFolderAt(queryable:Queryable, collectionId:string, path:string):Promise<any> {
    return (await queryable.query('SELECT * FROM file_folders WHERE collection_id=$1 AND path=$2 AND deleted_at IS NULL', [collectionId, path])).rows[0];
  }

  async setFolderMetadata(client:pg.PoolClient, table:MetadataTable, id:string, metadata:Record<string, unknown>, description:unknown, namingHint:unknown):Promise<void> {
    await client.query(`UPDATE ${table} SET metadata=$2,description=$3,naming_hint=$4,metadata_revision=metadata_revision+1,updated_at=NOW() WHERE id=$1`, [id, metadata, description, namingHint]);
  }

  async setMetadata(client:pg.PoolClient, table:MetadataTable, id:string, metadata:Record<string, unknown>):Promise<void> {
    await client.query(`UPDATE ${table} SET metadata=$2,metadata_revision=metadata_revision+1,updated_at=NOW() WHERE id=$1`, [id, metadata]);
  }

  async row(client:pg.PoolClient, table:MetadataTable, id:string):Promise<any> {
    return (await client.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];
  }

  async auditChange(client:pg.PoolClient, whoType:string, whoId:string, deviceOrRunId:string | null, fileId:string | null, details:Record<string, unknown>):Promise<void> {
    await client.query(
      `INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,action,details) VALUES($1,$2,$3,$4,'metadata-set',$5)`,
      [whoType, whoId, deviceOrRunId, fileId, details]);
  }

  /** Metadata of the direct child files of one folder (only files that carry any). */
  async childFileMetadata(collectionId:string, prefix:string):Promise<any[]> {
    return (await this.db.query(`SELECT path,metadata,metadata_revision FROM files WHERE collection_id=$1 AND deleted_at IS NULL AND path LIKE $2 AND position('/' in substring(path from $3))=0 AND metadata<>'{}'::jsonb`, [collectionId, `${prefix}%`, prefix.length + 1])).rows;
  }
}
