// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Envelope } from '../crypto.js';
import type pg from 'pg';

export interface LegacyWrappedCollectionKeys { data_key: Envelope; dedup_key: Envelope }

/** Reads and maps the source identities inside the publication snapshot. */
export class LegacyImportIdentityRepository {
  /** Maps files that appeared in legacy collections after staging. */
  async mapLegacySourceFiles(client:pg.PoolClient):Promise<void> {
    await client.query(`INSERT INTO files_legacy_file_map(source_file_id,shadow_file_id,source_collection_id,shadow_collection_id)
          SELECT f.id,gen_random_uuid(),f.collection_id,m.shadow_collection_id FROM files f JOIN collections c ON c.id=f.collection_id AND c.legacy_source=TRUE
          JOIN files_legacy_collection_map m ON m.source_collection_id=f.collection_id ON CONFLICT(source_file_id) DO NOTHING`);
  }

  async mapVersions(client:pg.PoolClient):Promise<void> {
    await client.query(`INSERT INTO files_legacy_version_map(source_version_id,shadow_version_id)
          SELECT v.id,gen_random_uuid() FROM file_versions v JOIN files_legacy_file_map f ON f.source_file_id=v.file_id ON CONFLICT(source_version_id) DO NOTHING`);
  }

  /** True when any legacy file, its current version, or any legacy version still lacks an identity map row. */
  async identityIncomplete(client:pg.PoolClient):Promise<boolean> {
    const incomplete = await client.query(`SELECT 1 FROM files f JOIN collections c ON c.id=f.collection_id AND c.legacy_source=TRUE
          LEFT JOIN files_legacy_file_map fm ON fm.source_file_id=f.id LEFT JOIN files_legacy_version_map vm ON vm.source_version_id=f.current_version_id
          WHERE fm.source_file_id IS NULL OR (f.current_version_id IS NOT NULL AND vm.source_version_id IS NULL) LIMIT 1`);
    const missingVersion = await client.query(`SELECT 1 FROM file_versions v JOIN files f ON f.id=v.file_id JOIN collections c ON c.id=f.collection_id AND c.legacy_source=TRUE
          LEFT JOIN files_legacy_version_map vm ON vm.source_version_id=v.id WHERE vm.source_version_id IS NULL LIMIT 1`);
    return Boolean(incomplete.rowCount || missingVersion.rowCount);
  }

  async collectionKeys(client:pg.PoolClient, collectionId:string):Promise<LegacyWrappedCollectionKeys | undefined> {
    return (await client.query('SELECT data_key,dedup_key FROM files_collection_keys WHERE collection_id=$1', [collectionId])).rows[0];
  }

  /** Every mapped source version with its manifest, in id order. Reviewed unbounded read: the import converts every legacy version once. */
  async mappedVersions(client:pg.PoolClient):Promise<any[]> {
    return (await client.query(`SELECT v.*,m.chunk_ids,m.total_size FROM file_versions v JOIN files f ON f.id=v.file_id
            LEFT JOIN manifests m ON m.hash=v.manifest_hash JOIN files_legacy_file_map fm ON fm.source_file_id=f.id ORDER BY v.id`)).rows;
  }
}
