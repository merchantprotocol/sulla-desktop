// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface SnapshotPrunePolicy { keepRecent:number; dailyDays:number; batchSize:number }

/** SQL for redundant Automerge snapshot payload removal (see AutomergeSnapshotRetention). */
export class AutomergeSnapshotRepository {
  /** Ranks one file's snapshots and blanks the redundant payloads (keep the newest
   * $2, plus the last snapshot of each day for $3 days, plus the current version). */
  static readonly FILE_PRUNE_SQL = `WITH ranked AS (
      SELECT av.version_id, av.created_at,
        row_number() OVER (ORDER BY av.created_at DESC, av.version_id DESC) AS recent_rank,
        row_number() OVER (PARTITION BY av.created_at::date ORDER BY av.created_at DESC, av.version_id DESC) AS day_rank
      FROM file_automerge_versions av
      WHERE av.file_id=$1 AND av.document IS NOT NULL
    ), candidates AS (
      SELECT r.version_id FROM ranked r
      WHERE r.recent_rank > $2
        AND (r.created_at < NOW() - make_interval(days => $3) OR r.day_rank > 1)
        AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id=$1 AND f.current_version_id=r.version_id)
      ORDER BY r.created_at
      LIMIT $4
    )
    UPDATE file_automerge_versions av SET document=NULL
    FROM candidates c
    WHERE av.version_id=c.version_id AND av.file_id=$1
    RETURNING av.version_id`;

  /** Next distinct file ids after the cursor, reading at most $2 index rows. */
  static readonly FILE_SCAN_SQL = `SELECT DISTINCT file_id::text AS file_id FROM (
      SELECT file_id FROM file_automerge_versions WHERE file_id > $1::uuid ORDER BY file_id LIMIT $2
    ) scan ORDER BY 1`;

  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** Keyset page of file ids that have snapshots, strictly after `cursor`. */
  async nextFileIds(cursor:string, scanRows:number):Promise<string[]> {
    const rows = (await this.db.query(AutomergeSnapshotRepository.FILE_SCAN_SQL, [cursor, scanRows])).rows as { file_id:string }[];
    return rows.map(row => row.file_id);
  }

  /** Inside the caller's transaction: caps the statement time, then blanks one file's redundant payloads. */
  async pruneFile(client:pg.PoolClient, fileId:string, policy:SnapshotPrunePolicy, budgetMs:number):Promise<number> {
    await client.query("SELECT set_config('statement_timeout',$1,true)", [`${ budgetMs }ms`]);
    const result = await client.query(AutomergeSnapshotRepository.FILE_PRUNE_SQL, [fileId, policy.keepRecent, policy.dailyDays, policy.batchSize]);
    return result.rowCount ?? result.rows.length;
  }
}
