// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface CatalogCollectionRow {
  id:   string;
  name: string;
}

export interface CatalogFileRow {
  id:         string;
  path:       string;
  mime:       string | null;
  size:       string | number | null;
  updated_at: string;
}

/**
 * What the Sulla Cloud web Files screen may see: collections the owner explicitly showed in
 * Cloud (never the audit logs area) and their unprotected, live files. Metadata only.
 */
export class PgCloudCatalogRepository {
  /** Collections the owner explicitly showed in Sulla Cloud ($1 = owner user id). Never the audit logs area. */
  static readonly visibleCollection = `owner_user_id = $1 AND cloud_catalog_sync = TRUE AND published = TRUE AND legacy_source = FALSE AND system_area IS DISTINCT FROM 'logs'`;

  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async visibleCollections(ownerUserId:string):Promise<CatalogCollectionRow[]> {
    return (await this.db.query<CatalogCollectionRow>(
      `SELECT id, name FROM collections WHERE ${ PgCloudCatalogRepository.visibleCollection } ORDER BY created_at`,
      [ownerUserId],
    )).rows;
  }

  /** Live files in path order, at most `limit`; files marked protected never leave the device. */
  async visibleFiles(collectionId:string, limit:number):Promise<CatalogFileRow[]> {
    return (await this.db.query<CatalogFileRow>(
      `SELECT id, path, mime, size, updated_at FROM files
        WHERE collection_id = $1 AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM files_protected_files p WHERE p.file_id = files.id)
        ORDER BY path LIMIT $2`,
      [collectionId, limit],
    )).rows;
  }

  /** The live file, only while its collection is still shown in Cloud for this owner. */
  async visibleFile(ownerUserId:string, fileId:string):Promise<{ id:string; path:string } | null> {
    return (await this.db.query(
      `SELECT f.id, f.path FROM files f
        WHERE f.id = $2 AND f.deleted_at IS NULL
          AND f.collection_id IN (SELECT id FROM collections WHERE ${ PgCloudCatalogRepository.visibleCollection })`,
      [ownerUserId, fileId],
    )).rows[0] ?? null;
  }
}
