// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface SystemAreaQueryable { query(sql:string, values?:unknown[]):Promise<{ rows:any[] }> }

export interface SystemAreaFileRow { id:string; current_version_id:string | null; deleted_at:Date | null; manifest_hash:string | null }

/** SQL for mirroring one system-area file; every method runs on the ingest transaction's client. */
export class SystemAreaIngestRepository {
  /** The file at (collection, path) with its current manifest, row-locked for the rest of the transaction. */
  async lockFileAtPath(client:SystemAreaQueryable, collectionId:string, path:string):Promise<SystemAreaFileRow | undefined> {
    return (await client.query(`SELECT f.id::text,f.current_version_id::text,f.deleted_at,v.manifest_hash FROM files f
      LEFT JOIN file_versions v ON v.id=f.current_version_id WHERE f.collection_id=$1 AND f.path=$2 FOR UPDATE OF f`, [collectionId, path])).rows[0];
  }

  /**
   * After the version is current: drops the index job the files trigger queued (it is not yet
   * visible to the indexer) and records why the version is not searchable.
   */
  async skipSearchIndex(client:SystemAreaQueryable, fileId:string, versionId:string):Promise<void> {
    await client.query('DELETE FROM file_index_jobs WHERE file_id=$1 AND version_id=$2', [fileId, versionId]);
    await client.query('DELETE FROM file_search_text WHERE file_id=$1', [fileId]);
    await client.query(`UPDATE files SET extracted_at=NOW(),extraction_status='unsupported',
    extraction_reason_code='system_area_unindexed',extraction_reason='System-area files are stored without search indexing.'
    WHERE id=$1 AND current_version_id=$2`, [fileId, versionId]);
  }
}
