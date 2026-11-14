// SPDX-License-Identifier: GPL-2.0-or-later
import type pg from 'pg';

const FIRST_FILE = '00000000-0000-0000-0000-000000000000';

/** Bounded, restart-safe removal of redundant Automerge snapshot payloads.
 * Heads remain indexed for stale-branch merges and file_versions/manifests are
 * untouched, so restore continues to use its canonical content history.
 *
 * Work is done one file at a time: a keyset scan over file ids (bounded by
 * fileScanRows index rows) picks the next files, and a single window-function
 * pass per file decides what to keep. Cost per run never depends on the total
 * number of snapshots in the table, only on the files visited in the budget.
 */
export class AutomergeSnapshotRetention {
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

  private running = false;
  private cursor = FIRST_FILE;

  constructor(
    private readonly db: pg.Pool,
    private readonly keepRecent = 50,
    private readonly dailyDays = 30,
    private readonly batchSize = 100,
    private readonly timeBudgetMs = 1_000,
    private readonly fileScanRows = 2_000,
  ) {}

  static fromEnvironment(db: pg.Pool): AutomergeSnapshotRetention {
    const setting = (name:string, fallback:number, maximum:number) => {
      const value=Number(process.env[name]);
      return Number.isSafeInteger(value)&&value>=1 ? Math.min(value,maximum) : fallback;
    };
    return new AutomergeSnapshotRetention(db,
      setting('SULLA_FILES_AUTOMERGE_KEEP_RECENT',50,500),
      setting('SULLA_FILES_AUTOMERGE_DAILY_DAYS',30,365),
      setting('SULLA_FILES_AUTOMERGE_PRUNE_BATCH',100,500),
      setting('SULLA_FILES_AUTOMERGE_PRUNE_BUDGET_MS',1_000,10_000));
  }

  async prune(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const started = Date.now();
    const remaining = () => this.timeBudgetMs - (Date.now() - started);
    let removed = 0;
    try {
      while (remaining() > 0) {
        const files = (await this.db.query(AutomergeSnapshotRetention.FILE_SCAN_SQL, [this.cursor, this.fileScanRows])).rows as { file_id:string }[];
        if (files.length === 0) { this.cursor = FIRST_FILE; break; } // one full lap done; resume next run
        for (const { file_id: fileId } of files) {
          if (remaining() <= 0) return removed;
          removed += await this.pruneFile(fileId, Math.max(1, remaining()));
          this.cursor = fileId;
        }
      }
      return removed;
    } finally { this.running = false; }
  }

  private async pruneFile(fileId:string, budgetMs:number): Promise<number> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout',$1,true)",[`${ budgetMs }ms`]);
      const result = await client.query(AutomergeSnapshotRetention.FILE_PRUNE_SQL, [fileId, this.keepRecent, this.dailyDays, this.batchSize]);
      await client.query('COMMIT');
      return result.rowCount ?? result.rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
