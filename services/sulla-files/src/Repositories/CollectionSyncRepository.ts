// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Collections, their change journal, and the version bundles sync clients read. */
export class CollectionSyncRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>, private readonly fileRowJsonSql:string) {}

  /** Published, non-legacy collections other than the Sulla system area, in explorer order. */
  async listed():Promise<any[]> {
    return (await this.db.query("SELECT * FROM collections WHERE published=TRUE AND legacy_source=FALSE AND system_area IS DISTINCT FROM 'sulla' ORDER BY explorer_path,name")).rows;
  }

  /** Registers a synced knowledge collection once; an existing id is left untouched. */
  async createKnowledge(ownerUserId:string, collection:any):Promise<void> {
    await this.db.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy) VALUES($1,$2,$3,$4,'knowledge','synced','org-readable',$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`, [collection.id, collection.org_id, ownerUserId, collection.name, collection.encrypted_data_key, collection.dedup_key_ciphertext, collection.retention_policy ?? {}]);
  }

  /** The highest journal or purge-tombstone sequence in the collection, as text. */
  async journalHead(collectionId:string):Promise<string> {
    return (await this.db.query(`SELECT GREATEST(
          COALESCE((SELECT MAX(seq) FROM journal WHERE collection_id=$1),0),
          COALESCE((SELECT MAX(seq) FROM file_purge_tombstones WHERE collection_id=$1),0)
        )::text AS seq`, [collectionId])).rows[0].seq;
  }

  /** Up to 1000 changed paths after a sequence (journal and purge tombstones), excluding protected files. */
  async changedPaths(collectionId:string, after:number):Promise<Array<{ seq:string; path:string }>> {
    return (await this.db.query(`SELECT seq,path FROM (
        SELECT j.seq,f.path FROM journal j JOIN files f ON f.id=j.file_id
          WHERE j.collection_id=$1 AND j.seq>$2 AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
        UNION ALL SELECT seq,path FROM file_purge_tombstones WHERE collection_id=$1 AND seq>$2
      ) changes ORDER BY seq LIMIT 1000`, [collectionId, after])).rows;
  }

  /** Up to 1000 journal entries after a sequence with their file, version, manifest and system area. */
  async journalEntries(collectionId:string, after:number):Promise<any[]> {
    const filter = '';
    return (await this.db.query(`SELECT j.*,${this.fileRowJsonSql} file,row_to_json(v.*) version,row_to_json(m.*) manifest,json_build_object('system_area',c.system_area) collection FROM journal j JOIN files f ON f.id=j.file_id JOIN file_versions v ON v.id=j.version_id JOIN collections c ON c.id=f.collection_id LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) AND j.collection_id=$1 AND j.seq>$2${ filter } ORDER BY j.seq LIMIT 1000`, [collectionId, after])).rows;
  }

  async purgeTombstones(collectionId:string, after:number):Promise<any[]> {
    return (await this.db.query('SELECT seq,collection_id,file_id,path,lifecycle_generation,purged_at,audience FROM file_purge_tombstones WHERE collection_id=$1 AND seq>$2 ORDER BY seq LIMIT 1000', [collectionId, after])).rows;
  }

  /** One version with its manifest, file, collection system area and key context, or undefined. */
  async versionBundle(versionId:string):Promise<any> {
    return (await this.db.query(`SELECT row_to_json(v.*) version,row_to_json(m.*) manifest,json_build_object('system_area',c.system_area) collection,${this.fileRowJsonSql} file,
      CASE WHEN k.version_id IS NULL THEN NULL ELSE json_build_object('collectionId',k.collection_id,'principalId',k.principal_id,'keyVersion',k.key_version,'epoch',k.key_epoch) END AS "keyContext"
      FROM file_versions v JOIN files f ON f.id=v.file_id JOIN collections c ON c.id=f.collection_id LEFT JOIN manifests m ON m.hash=v.manifest_hash LEFT JOIN file_version_key_contexts k ON k.version_id=v.id WHERE v.id=$1`, [versionId])).rows[0];
  }

  /** Recording transcript/chapters for one file version, with its collection and path, or undefined. */
  async recordingMetadata(fileId:string, versionId:string):Promise<any> {
    return (await this.db.query(`SELECT f.collection_id,f.path,m.version_id,m.language,m.transcript,m.chapters,m.duration_seconds,m.generator,m.generated_at
      FROM recording_metadata m JOIN files f ON f.id=m.file_id WHERE m.file_id=$1 AND m.version_id=$2`, [fileId, versionId])).rows[0];
  }
}
