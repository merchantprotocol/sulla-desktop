// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface SyncBundleRow {
  collection: Record<string, any>;
  file:       Record<string, any>;
  version:    Record<string, any>;
  manifest:   Record<string, any>;
}

/** Reads the exact rows the Files sync API publishes for one current, immutable version. */
export class ResidencySyncBundleRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async findCurrentVersionBundle(versionId:string, fileId:string, collectionId:string):Promise<SyncBundleRow | undefined> {
    return (await this.db.query(
      `SELECT row_to_json(c.*) AS collection,row_to_json((SELECT x FROM (SELECT f.id,f.collection_id,f.path,f.current_version_id,f.deleted_at,f.expires_at,f.created_by_type,f.created_by_id,f.mime,f.size,f.created_at,f.updated_at,f.extraction_status,f.draft_version_id,f.published_version_id,f.versioning_enabled,f.major_minor_enabled,f.require_approval,f.require_checkout,f.retention_mode,f.retain_until,f.record_lock_type,f.lifecycle_generation,f.operation_revision) x)) AS file,row_to_json(v.*) AS version,row_to_json(m.*) AS manifest
         FROM files f JOIN file_versions v ON v.id=$1 AND v.file_id=f.id
         JOIN collections c ON c.id=f.collection_id
         JOIN manifests m ON m.hash=v.manifest_hash
        WHERE f.id=$2 AND f.collection_id=$3 AND f.current_version_id=v.id AND NOT v.deleted`,
      [versionId, fileId, collectionId],
    )).rows[0];
  }

  async findChunks(chunkCollectionId:string, ids:string[]):Promise<Record<string, any>[]> {
    return (await this.db.query(
      `SELECT id,size,stored_size,location FROM chunks
        WHERE collection_id=$1 AND id=ANY($2::text[])`,
      [chunkCollectionId, ids],
    )).rows;
  }
}
