// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type FinderBadgeState = 'backed-up' | 'error' | 'indexed' | 'processing' | 'not-indexed';

/** Which local collections can be backed up, and what the owner sees about them. Logs are never sync candidates. */
export class PgCloudCollectionCatalogRepository {
  constructor(private readonly db:pg.Pool) {}

  async statusRows():Promise<any[]> {
    return (await this.db.query(`SELECT c.id::text AS collection_id,c.name,s.enabled,COALESCE(s.status,'off') AS status,s.last_sync_at,
        COALESCE(s.pending_bytes,0) AS pending_bytes,COALESCE(s.conflicts,0) AS conflicts,s.last_error
      FROM collections c LEFT JOIN files_cloud_sync s ON s.collection_id=c.id
      WHERE c.published=TRUE AND c.legacy_source=FALSE AND (c.system_area IS NULL OR c.system_area <> 'logs')
      ORDER BY c.name,c.id`)).rows;
  }

  async backupCandidate(collectionId:string):Promise<boolean> {
    if (!UUID.test(collectionId)) return false;
    return Boolean((await this.db.query(`SELECT 1 FROM collections WHERE id=$1 AND published=TRUE AND legacy_source=FALSE
      AND (system_area IS NULL OR system_area <> 'logs')`, [collectionId])).rowCount);
  }

  async localCollectionIds(ids:string[]):Promise<Set<string>> {
    const valid = ids.filter(id => UUID.test(id));
    if (!valid.length) return new Set();
    const rows = (await this.db.query('SELECT id::text AS id FROM collections WHERE id=ANY($1::uuid[])', [valid])).rows;
    return new Set(rows.map(row => String(row.id)));
  }

  /** Per-file Finder badge: in the encrypted Cloud backup, or only indexed by Sulla, or still being processed. */
  async finderBadges(collectionId:string):Promise<Array<{ path:string; state:FinderBadgeState }>> {
    return (await this.db.query(`SELECT f.path,
        CASE WHEN s.enabled AND cv.version_id IS NOT NULL THEN 'backed-up'
             WHEN s.enabled AND EXISTS(SELECT 1 FROM files_cloud_skips k WHERE k.version_id=f.current_version_id) THEN 'error'
             WHEN f.extraction_status='indexed' THEN 'indexed'
             WHEN f.extraction_status IN ('failed','unsupported') THEN 'not-indexed'
             ELSE 'processing' END AS state
      FROM files f
      LEFT JOIN files_cloud_sync s ON s.collection_id=f.collection_id
      LEFT JOIN files_cloud_versions cv ON cv.version_id=f.current_version_id
      WHERE f.collection_id=$1 AND f.deleted_at IS NULL`, [collectionId])).rows;
  }
}
