// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { SqlFragment } from '../FileListingQuery.js';

/** GET /v1/files rows: each file with its visible version, residency and native-conflict sync state. */
export class FileListingRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>, private readonly fileColumnsSql:string) {}

  /**
   * One keyset page. FileListingQuery binds the row limit last; the ORDER BY / LIMIT is spelled out
   * here (and checked against the scope) so the bound stays visible to UnboundedReadGuard.
   */
  async page(scope:SqlFragment):Promise<any[]> {
    const limitParam = scope.values.length;
    if (scope.orderLimit !== `ORDER BY f.path LIMIT $${ limitParam }`) throw new Error('file listing scope must end with its path-ordered row limit');
    const rows = await this.db.query(`SELECT ${this.fileColumnsSql},v.created_at AS version_created_at,v.created_by_type AS version_created_by_type,v.created_by_id AS version_created_by_id,v.size AS visible_size,nc.source_file_id AS conflict_source_file_id,sf.current_version_id AS conflict_source_version_id,CASE WHEN nc.file_id IS NOT NULL OR ns.state='conflict' THEN 'conflict' WHEN r.state='online-only' THEN 'online-only' WHEN r.state IN('evicting','hydrating') THEN 'syncing' ELSE NULL END AS sync_state
      FROM files f LEFT JOIN file_versions v ON v.id=f.current_version_id LEFT JOIN file_residency r ON r.file_id=f.id LEFT JOIN files_native_conflicts nc ON nc.file_id=f.id LEFT JOIN files sf ON sf.id=nc.source_file_id LEFT JOIN files_native_sources ns ON ns.file_id=f.id
      WHERE ${ scope.where } ORDER BY f.path LIMIT $${ limitParam }`, scope.values);
    return rows.rows;
  }
}
