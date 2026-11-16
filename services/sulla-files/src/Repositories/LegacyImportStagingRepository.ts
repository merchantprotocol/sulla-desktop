// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Envelope } from '../crypto.js';
import type pg from 'pg';

export interface LegacySourceCollection { id: string; encrypted_data_key: Envelope; dedup_key_ciphertext: Envelope; compatibility_state: string }
export interface LegacyCollectionMapping { source_collection_id: string; shadow_collection_id: string; published_at: Date | null }

/** Staging SQL: marks legacy sources, creates native shadow collections and stable identity maps. */
export class LegacyImportStagingRepository {
  /** Pulls collections that share versions/chunks with a legacy source into the source set; returns rows changed. */
  async expandSources(client:pg.PoolClient):Promise<number | null> {
    const result = await client.query(`UPDATE collections c SET legacy_source=TRUE WHERE c.legacy_source=FALSE AND (
          EXISTS (SELECT 1 FROM files f JOIN file_versions v ON v.file_id=f.id JOIN collections chunks ON chunks.id=v.chunk_collection_id WHERE f.collection_id=c.id AND chunks.legacy_source=TRUE)
          OR EXISTS (SELECT 1 FROM file_versions v JOIN files f ON f.id=v.file_id JOIN collections owner ON owner.id=f.collection_id WHERE v.chunk_collection_id=c.id AND owner.legacy_source=TRUE))`);
    return result.rowCount;
  }

  async lockSourceCollections(client:pg.PoolClient):Promise<LegacySourceCollection[]> {
    return (await client.query<LegacySourceCollection>('SELECT id::text,encrypted_data_key,dedup_key_ciphertext,compatibility_state FROM collections WHERE legacy_source=TRUE ORDER BY id FOR UPDATE')).rows;
  }

  async protectSourceFiles(client:pg.PoolClient):Promise<void> {
    await client.query(`INSERT INTO files_protected_files(file_id) SELECT f.id FROM files f JOIN collections c ON c.id=f.collection_id WHERE c.legacy_source=TRUE ON CONFLICT DO NOTHING`);
  }

  /** Revokes any completed receipt before identity-map changes commit. */
  async markStaging(client:pg.PoolClient):Promise<void> {
    await client.query("INSERT INTO files_legacy_imports(id,state) VALUES(TRUE,'staging') ON CONFLICT(id) DO UPDATE SET state='staging',completed_at=NULL");
  }

  async findCollectionMapping(client:pg.PoolClient, sourceCollectionId:string):Promise<Record<string, unknown> | undefined> {
    return (await client.query('SELECT * FROM files_legacy_collection_map WHERE source_collection_id=$1', [sourceCollectionId])).rows[0];
  }

  /** An unpublished native shadow of `sourceCollectionId` with its own random wrapped keys, plus its map row. */
  async createShadowCollection(client:pg.PoolClient, sourceCollectionId:string, shadowCollectionId:string, wrappedData:Envelope, wrappedDedup:Envelope):Promise<void> {
    await client.query(`INSERT INTO collections(id,org_id,owner_user_id,agent_run_id,thread_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy,created_at,updated_at,compatibility_state,legacy_source,published)
              SELECT $2,org_id,owner_user_id,agent_run_id,thread_id,name,kind,home,encryption,$3,$4,retention_policy,created_at,updated_at,'native',FALSE,FALSE FROM collections WHERE id=$1`, [sourceCollectionId, shadowCollectionId, wrappedData, wrappedDedup]);
    await client.query("INSERT INTO files_collection_keys(collection_id,data_key,dedup_key,key_origin) VALUES($1,$2,$3,'random')", [shadowCollectionId, wrappedData, wrappedDedup]);
    await client.query('INSERT INTO files_legacy_collection_map(source_collection_id,shadow_collection_id) VALUES($1,$2)', [sourceCollectionId, shadowCollectionId]);
  }

  async listCollectionMappings(client:pg.PoolClient):Promise<LegacyCollectionMapping[]> {
    return (await client.query('SELECT source_collection_id::text,shadow_collection_id::text,published_at FROM files_legacy_collection_map ORDER BY source_collection_id')).rows;
  }

  async mapFiles(client:pg.PoolClient):Promise<void> {
    await client.query(`INSERT INTO files_legacy_file_map(source_file_id,shadow_file_id,source_collection_id,shadow_collection_id)
        SELECT f.id,gen_random_uuid(),f.collection_id,m.shadow_collection_id FROM files f JOIN files_legacy_collection_map m ON m.source_collection_id=f.collection_id ON CONFLICT(source_file_id) DO NOTHING`);
  }

  async mapVersions(client:pg.PoolClient):Promise<void> {
    await client.query(`INSERT INTO files_legacy_version_map(source_version_id,shadow_version_id)
        SELECT v.id,gen_random_uuid() FROM file_versions v JOIN files_legacy_file_map f ON f.source_file_id=v.file_id ON CONFLICT(source_version_id) DO NOTHING`);
  }
}
