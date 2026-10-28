// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Plain, read-only mirroring of Desktop's system area (the bundled Sulla docs
 * and use cases) into Files.
 *
 * Unlike user-picked native sources this creates no files_native_sources or
 * files_native_source_operations rows, no source handles, no publication
 * planning and no recovery state: system areas are one-way inputs. An
 * unchanged file (same manifest as its current version) is a no-op, so a
 * Desktop restart never creates new versions of unchanged files.
 *
 * The Logs collection is the Files service's internal audit store (audit/files,
 * audit/vault): it is never a mirroring target and is never search-indexed.
 * The legacy skip-search header is accepted but cannot change that.
 */
export const SKIP_SEARCH_INDEX_HEADER = 'x-sulla-files-skip-search-index';
export const UNINDEXED_SYSTEM_AREAS = new Set(['logs']);
const SYSTEM_AREAS = new Set(['sulla']);

export interface Queryable { query(sql:string, values?:unknown[]):Promise<{ rows:any[] }> }
export interface ConnectionPool { connect():Promise<Queryable & { release():void }> }

export interface MirroredSystemFile { id:string; current_version_id:string; unchanged:boolean }

export function isSystemArea(systemArea:unknown):boolean {
  return typeof systemArea === 'string' && SYSTEM_AREAS.has(systemArea);
}

export function shouldSkipSearchIndex(_headerValue:string | undefined, systemArea:unknown):boolean {
  return typeof systemArea === 'string' && UNINDEXED_SYSTEM_AREAS.has(systemArea);
}

/**
 * Runs inside the ingest transaction, after the version is current: drops the
 * index job the files trigger queued (it is not yet visible to the indexer)
 * and records why the version is not searchable.
 */
export async function skipSearchIndexForVersion(client:Queryable, fileId:string, versionId:string):Promise<void> {
  await client.query('DELETE FROM file_index_jobs WHERE file_id=$1 AND version_id=$2', [fileId, versionId]);
  await client.query('DELETE FROM file_search_text WHERE file_id=$1', [fileId]);
  await client.query(`UPDATE files SET extracted_at=NOW(),extraction_status='unsupported',
    extraction_reason_code='system_area_unindexed',extraction_reason='System-area files are stored without search indexing.'
    WHERE id=$1 AND current_version_id=$2`, [fileId, versionId]);
}

/**
 * Stores one system-area file. `insertVersion` writes the chunks/version
 * (reusing `existing` when the path already has a file); `lockNamespace`
 * serialises namespace changes in the collection.
 */
export async function mirrorSystemAreaFile(db:ConnectionPool, input:{
  collectionId:    string;
  path:            string;
  manifestHash:    string;
  skipSearchIndex: boolean;
}, deps:{
  lockNamespace(client:Queryable, collectionId:string):Promise<void>;
  insertVersion(client:Queryable, existing?:{ id:string; current_version_id:string | null }):Promise<{ id:string; current_version_id:string }>;
}):Promise<MirroredSystemFile> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await deps.lockNamespace(client, input.collectionId);
    const existing = (await client.query(`SELECT f.id::text,f.current_version_id::text,f.deleted_at,v.manifest_hash FROM files f
      LEFT JOIN file_versions v ON v.id=f.current_version_id WHERE f.collection_id=$1 AND f.path=$2 FOR UPDATE OF f`, [input.collectionId, input.path])).rows[0] as
      { id:string; current_version_id:string | null; deleted_at:Date | null; manifest_hash:string | null } | undefined;
    if (existing?.current_version_id && !existing.deleted_at && existing.manifest_hash === input.manifestHash) {
      await client.query('COMMIT');
      return { id: existing.id, current_version_id: existing.current_version_id, unchanged: true };
    }
    const inserted = await deps.insertVersion(client, existing ? { id: existing.id, current_version_id: existing.current_version_id } : undefined);
    if (input.skipSearchIndex) await skipSearchIndexForVersion(client, inserted.id, inserted.current_version_id);
    await client.query('COMMIT');
    return { id: inserted.id, current_version_id: inserted.current_version_id, unchanged: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release() }
}
