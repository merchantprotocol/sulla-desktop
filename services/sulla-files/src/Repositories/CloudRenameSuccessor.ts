// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';

export interface RenamedFile {
  fileId:string;
  currentVersionId:string;
  /** True when the file moved only because an ancestor folder moved, so its own name and parent identity are unchanged. */
  parentFollows:boolean;
}

/**
 * A rename or move of a file that Cloud already holds must reach Cloud as a new namespace
 * version: the uploader only pushes versions Cloud has not seen, so journaling the same
 * version id again was silently skipped. This adds one successor version carrying the same
 * content (same manifest, chunk refs +1) and returns its id for the rename journal row.
 *
 * Nothing is rewritten: the old version stays in history. The successor is attempted under
 * a savepoint and abandoned (the rename still succeeds, unchanged from before) when the
 * document lifecycle refuses it or would not publish it: record locks, checkout,
 * approval-required files and agent Use Case drafts keep their existing behavior.
 */
export class CloudRenameSuccessor {
  /** The files row after the last successor was added (null when versionFor kept the current version). */
  updatedFile:Record<string, unknown> | null = null;

  constructor(private readonly actor:Pick<FilesIdentity, 'deviceId'>) {}

  async versionFor(client:pg.PoolClient, file:RenamedFile):Promise<string> {
    this.updatedFile = null;
    if (file.parentFollows) return file.currentVersionId;
    const uploaded = (await client.query('SELECT 1 FROM files_cloud_versions WHERE version_id=$1', [file.currentVersionId])).rowCount;
    if (!uploaded) return file.currentVersionId; // the pending upload already reads the new path
    await client.query('SAVEPOINT cloud_rename_successor');
    try {
      const source = (await client.query(`SELECT v.chunk_collection_id,v.manifest_hash,v.size,v.created_by_type,v.created_by_id,v.publication_status,m.chunk_ids
        FROM file_versions v LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.file_id=$2 AND v.deleted=FALSE`,
      [file.currentVersionId, file.fileId])).rows[0];
      if (!source || source.publication_status !== 'published') {
        await client.query('ROLLBACK TO SAVEPOINT cloud_rename_successor');
        return file.currentVersionId;
      }
      const created = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id)
        VALUES($1,$2,$3,$4,$5,FALSE,$6,$7,'Renamed or moved',$8) RETURNING id::text AS id,publication_status`,
      [file.fileId, source.chunk_collection_id, file.currentVersionId, source.manifest_hash, source.size, source.created_by_type, source.created_by_id,
        (this.actor.deviceId || 'server-web').slice(0, 128)])).rows[0];
      if (created?.publication_status !== 'published') {
        await client.query('ROLLBACK TO SAVEPOINT cloud_rename_successor');
        return file.currentVersionId;
      }
      const chunkIds:string[] = source.chunk_ids ?? [];
      if (chunkIds.length) await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [source.chunk_collection_id, chunkIds]);
      this.updatedFile = (await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1 RETURNING *', [file.fileId, created.id])).rows[0] ?? null;
      await client.query('RELEASE SAVEPOINT cloud_rename_successor');
      return created.id;
    } catch (error:any) {
      this.updatedFile = null;
      if (error?.code !== '55000') throw error;
      await client.query('ROLLBACK TO SAVEPOINT cloud_rename_successor');
      return file.currentVersionId;
    }
  }
}
