// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Envelope } from '../crypto.js';
import type pg from 'pg';

export interface LegacyVersionRow {
  id: string; file_id: string; size: unknown; deleted: unknown; created_by_type: unknown; created_by_id: unknown; message: unknown; device_id: unknown;
}

/** Publication SQL: copies converted legacy content into the native shadows inside one snapshot transaction. */
export class LegacyImportPublicationRepository {
  async insertManifest(client:pg.PoolClient, hash:string, ids:string[], totalSize:number):Promise<{ chunk_ids: unknown; total_size: unknown } | undefined> {
    await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [hash, JSON.stringify(ids), totalSize]);
    return (await client.query('SELECT chunk_ids,total_size FROM manifests WHERE hash=$1', [hash])).rows[0];
  }

  async insertChunk(client:pg.PoolClient, collectionId:string, id:string, size:number, storedSize:number, location:string):Promise<{ size: unknown; stored_size: unknown; location: unknown } | undefined> {
    await client.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING', [collectionId, id, size, storedSize, location]);
    return (await client.query('SELECT size,stored_size,location FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId, id])).rows[0];
  }

  async publishFiles(client:pg.PoolClient):Promise<void> {
    await client.query(`INSERT INTO files(id,collection_id,path,deleted_at,expires_at,created_by_type,created_by_id,mime,size,created_at,updated_at,extracted_at,extraction_status,person_id)
        SELECT fm.shadow_file_id,fm.shadow_collection_id,f.path,f.deleted_at,f.expires_at,f.created_by_type,f.created_by_id,f.mime,f.size,f.created_at,f.updated_at,f.extracted_at,f.extraction_status,f.person_id
        FROM files f JOIN files_legacy_file_map fm ON fm.source_file_id=f.id ON CONFLICT(id) DO NOTHING`);
    await client.query(`INSERT INTO file_search_text(file_id,path,search_text)
        SELECT fm.shadow_file_id,f.path,s.search_text FROM files_legacy_file_map fm JOIN files f ON f.id=fm.source_file_id LEFT JOIN file_search_text s ON s.file_id=f.id
        ON CONFLICT(file_id) DO UPDATE SET search_text=EXCLUDED.search_text WHERE EXISTS(SELECT 1 FROM files target WHERE target.id=EXCLUDED.file_id AND target.current_version_id IS NULL)`);
  }

  async versionMap(client:pg.PoolClient):Promise<Map<string, string>> {
    return new Map((await client.query('SELECT source_version_id::text,shadow_version_id::text FROM files_legacy_version_map')).rows.map(row => [row.source_version_id, row.shadow_version_id]));
  }

  async fileMap(client:pg.PoolClient):Promise<Map<string, string>> {
    return new Map((await client.query('SELECT source_file_id::text,shadow_file_id::text FROM files_legacy_file_map')).rows.map(row => [row.source_file_id, row.shadow_file_id]));
  }

  async insertShadowVersion(client:pg.PoolClient, shadowVersionId:string | undefined, shadowFileId:string | undefined, shadowCollectionId:string, manifestHash:string | null, version:LegacyVersionRow):Promise<void> {
    await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id)
          SELECT $1,$2,$3,NULL,$4,$5,$6,$7,$8,created_at,$9,$10,NULL FROM file_versions WHERE id=$11
          ON CONFLICT(id) DO NOTHING`, [shadowVersionId, shadowFileId, shadowCollectionId, manifestHash, version.size, version.deleted, version.created_by_type, version.created_by_id, version.message, version.device_id, version.id]);
  }

  async recordVerifiedVersion(client:pg.PoolClient, sourceVersionId:string, manifestHash:string, plaintextHash:string):Promise<void> {
    await client.query('UPDATE files_legacy_version_map SET shadow_manifest_hash=$2,plaintext_sha256=$3,verified_at=NOW() WHERE source_version_id=$1', [sourceVersionId, manifestHash, plaintextHash]);
  }

  async setLineage(client:pg.PoolClient, shadowVersionId:string | undefined, parent:string | null | undefined, base:string | null | undefined):Promise<void> {
    await client.query('UPDATE file_versions SET parent_version_id=$2,base_server_version_id=$3 WHERE id=$1', [shadowVersionId, parent, base]);
  }

  /** Which provenance fields of any shadow version differ from its source. Reviewed unbounded read: aggregate over all mapped versions. */
  async versionConflicts(client:pg.PoolClient):Promise<Record<string, unknown>> {
    return (await client.query(`SELECT
        COALESCE(bool_or(shadow.file_id IS DISTINCT FROM fm.shadow_file_id),FALSE) file_mapping,
        COALESCE(bool_or(shadow.chunk_collection_id IS DISTINCT FROM cm.shadow_collection_id),FALSE) collection_mapping,
        COALESCE(bool_or(shadow.manifest_hash IS DISTINCT FROM vm.shadow_manifest_hash),FALSE) manifest_mapping,
        COALESCE(bool_or(shadow.parent_version_id IS DISTINCT FROM (SELECT p.shadow_version_id FROM files_legacy_version_map p WHERE p.source_version_id=source.parent_version_id)),FALSE) parent_mapping,
        COALESCE(bool_or(shadow.base_server_version_id IS DISTINCT FROM (SELECT b.shadow_version_id FROM files_legacy_version_map b WHERE b.source_version_id=source.base_server_version_id)),FALSE) base_mapping,
        COALESCE(bool_or(shadow.size IS DISTINCT FROM source.size),FALSE) size,
        COALESCE(bool_or(shadow.deleted IS DISTINCT FROM source.deleted),FALSE) deleted,
        COALESCE(bool_or(shadow.created_by_type IS DISTINCT FROM source.created_by_type),FALSE) creator_type,
        COALESCE(bool_or(shadow.created_by_id IS DISTINCT FROM source.created_by_id),FALSE) creator_id,
        COALESCE(bool_or(shadow.created_at IS DISTINCT FROM source.created_at),FALSE) created_at,
        COALESCE(bool_or(shadow.message IS DISTINCT FROM source.message),FALSE) message,
        COALESCE(bool_or(shadow.device_id IS DISTINCT FROM source.device_id),FALSE) device_id
      FROM file_versions source JOIN files_legacy_version_map vm ON vm.source_version_id=source.id
        JOIN file_versions shadow ON shadow.id=vm.shadow_version_id JOIN files_legacy_file_map fm ON fm.source_file_id=source.file_id
        JOIN files_legacy_collection_map cm ON cm.source_collection_id=source.chunk_collection_id`)).rows[0];
  }

  /** Points every shadow file at its mapped current version; true when any shadow still disagrees. */
  async publishCurrentVersions(client:pg.PoolClient):Promise<boolean> {
    await client.query(`UPDATE files shadow SET current_version_id=vm.shadow_version_id FROM files source
        JOIN files_legacy_file_map fm ON fm.source_file_id=source.id LEFT JOIN files_legacy_version_map vm ON vm.source_version_id=source.current_version_id
        WHERE shadow.id=fm.shadow_file_id`);
    const currentConflict = await client.query(`SELECT 1 FROM files source JOIN files_legacy_file_map fm ON fm.source_file_id=source.id
        JOIN files shadow ON shadow.id=fm.shadow_file_id LEFT JOIN files_legacy_version_map vm ON vm.source_version_id=source.current_version_id
        WHERE shadow.current_version_id IS DISTINCT FROM vm.shadow_version_id LIMIT 1`);
    return Boolean(currentConflict.rowCount);
  }

  async publishShares(client:pg.PoolClient):Promise<void> {
    await client.query(`INSERT INTO folder_shares(collection_id,folder_path,principal_type,principal_id,role,created_by,created_at,updated_at)
        SELECT m.shadow_collection_id,s.folder_path,s.principal_type,s.principal_id,s.role,s.created_by,s.created_at,s.updated_at FROM folder_shares s JOIN files_legacy_collection_map m ON m.source_collection_id=s.collection_id ON CONFLICT DO NOTHING`);
  }

  async publishEdges(client:pg.PoolClient):Promise<void> {
    await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,props,created_by,created_at)
        SELECT e.src_type,CASE WHEN e.src_type='file' THEN COALESCE(src.shadow_file_id::text,e.src_id) ELSE e.src_id END,
          e.dst_type,CASE WHEN e.dst_type='file' THEN COALESCE(dst.shadow_file_id::text,e.dst_id) ELSE e.dst_id END,e.kind,e.props,e.created_by,e.created_at FROM edges e
        LEFT JOIN files_legacy_file_map src ON e.src_type='file' AND src.source_file_id::text=e.src_id
        LEFT JOIN files_legacy_file_map dst ON e.dst_type='file' AND dst.source_file_id::text=e.dst_id
        WHERE src.shadow_file_id IS NOT NULL OR dst.shadow_file_id IS NOT NULL ON CONFLICT DO NOTHING`);
  }

  async publishJournal(client:pg.PoolClient):Promise<void> {
    await client.query(`INSERT INTO journal(collection_id,file_id,version_id,op,at)
        SELECT cm.shadow_collection_id,fm.shadow_file_id,vm.shadow_version_id,j.op,j.at FROM journal j JOIN files_legacy_collection_map cm ON cm.source_collection_id=j.collection_id JOIN files_legacy_file_map fm ON fm.source_file_id=j.file_id JOIN files_legacy_version_map vm ON vm.source_version_id=j.version_id
        WHERE NOT EXISTS(SELECT 1 FROM journal existing WHERE existing.collection_id=cm.shadow_collection_id AND existing.file_id=fm.shadow_file_id AND existing.version_id=vm.shadow_version_id AND existing.op=j.op AND existing.at=j.at)`);
  }

  async unmappedAudits(client:pg.PoolClient):Promise<any[]> {
    return (await client.query(`SELECT a.*,fm.shadow_file_id,vm.shadow_version_id FROM audit_log a JOIN files_legacy_file_map fm ON fm.source_file_id=a.file_id
        LEFT JOIN files_legacy_version_map vm ON vm.source_version_id=a.version_id LEFT JOIN files_legacy_audit_map am ON am.source_audit_id=a.id
        WHERE am.source_audit_id IS NULL ORDER BY a.id`)).rows;
  }

  async copyAudit(client:pg.PoolClient, audit:any):Promise<void> {
    const shadowAudit = (await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,at,details,org_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [audit.who_type, audit.who_id, audit.device_or_run_id, audit.shadow_file_id, audit.shadow_version_id, audit.action, audit.at, audit.details, audit.org_id])).rows[0];
    await client.query('INSERT INTO files_legacy_audit_map(source_audit_id,shadow_audit_id) VALUES($1,$2)', [audit.id, shadowAudit.id]);
  }

  async recountShadowChunkReferences(client:pg.PoolClient):Promise<void> {
    await client.query(`UPDATE chunks c SET refcount=q.refs FROM (SELECT v.chunk_collection_id collection_id,x.id,count(*) refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash CROSS JOIN LATERAL jsonb_array_elements_text(m.chunk_ids) x(id)
        JOIN files_legacy_version_map vm ON vm.shadow_version_id=v.id GROUP BY v.chunk_collection_id,x.id) q WHERE c.collection_id=q.collection_id AND c.id=q.id`);
  }

  /** True when a manifested version is unverified or any legacy version has no shadow. */
  async publicationIncomplete(client:pg.PoolClient):Promise<boolean> {
    const unverified = await client.query(`SELECT 1 FROM files_legacy_version_map vm JOIN file_versions v ON v.id=vm.source_version_id WHERE v.manifest_hash IS NOT NULL AND vm.verified_at IS NULL LIMIT 1`);
    const omitted = await client.query(`SELECT 1 FROM file_versions v JOIN files f ON f.id=v.file_id JOIN collections c ON c.id=f.collection_id AND c.legacy_source=TRUE
        LEFT JOIN files_legacy_version_map vm ON vm.source_version_id=v.id LEFT JOIN file_versions shadow ON shadow.id=vm.shadow_version_id WHERE shadow.id IS NULL LIMIT 1`);
    return Boolean(unverified.rowCount || omitted.rowCount);
  }

  /** Publishes the shadows, writes the completion receipt and clears preflight containment. */
  async complete(client:pg.PoolClient):Promise<void> {
    await client.query('UPDATE collections SET published=TRUE WHERE id IN(SELECT shadow_collection_id FROM files_legacy_collection_map)');
    await client.query('UPDATE files_legacy_collection_map SET published_at=COALESCE(published_at,NOW())');
    await client.query("UPDATE files_legacy_imports SET state='completed',completed_at=COALESCE(completed_at,NOW()) WHERE id=TRUE");
    await client.query("UPDATE files_legacy_preflight SET state='clear',reason='retired-external-chunk-store-converted',checked_at=NOW() WHERE id=TRUE");
  }

  async hasKeyState(client:pg.PoolClient):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM files_key_state WHERE id=TRUE')).rowCount);
  }

  async insertKeyState(client:pg.PoolClient, verifier:Envelope):Promise<void> {
    await client.query('INSERT INTO files_key_state(id,verifier) VALUES(TRUE,$1)', [verifier]);
  }
}
