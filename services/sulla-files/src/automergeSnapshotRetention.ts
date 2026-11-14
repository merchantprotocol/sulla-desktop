// SPDX-License-Identifier: GPL-2.0-or-later
import type pg from 'pg';

/** Bounded, restart-safe removal of redundant Automerge snapshot payloads.
 * Heads remain indexed for stale-branch merges and file_versions/manifests are
 * untouched, so restore continues to use its canonical content history.
 */
export class AutomergeSnapshotRetention {
  private running = false;
  constructor(
    private readonly db: pg.Pool,
    private readonly keepRecent = 50,
    private readonly dailyDays = 30,
    private readonly batchSize = 100,
    private readonly timeBudgetMs = 1_000,
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
    let removed = 0;
    try {
      while (Date.now() - started < this.timeBudgetMs) {
        const client = await this.db.connect();
        try {
          await client.query('BEGIN');
          const remaining=Math.max(1,this.timeBudgetMs-(Date.now()-started));
          await client.query("SELECT set_config('statement_timeout',$1,true)",[`${remaining}ms`]);
          const result = await client.query(`WITH candidates AS (
            SELECT av.version_id
            FROM file_automerge_versions av
            WHERE av.document IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id=av.file_id AND f.current_version_id=av.version_id)
              AND (SELECT COUNT(*) FROM file_automerge_versions newer
                   WHERE newer.file_id=av.file_id AND newer.document IS NOT NULL
                     AND (newer.created_at,newer.version_id)>(av.created_at,av.version_id)) >= $1
              AND (av.created_at < NOW() - ($2::text || ' days')::interval
                OR NOT EXISTS (SELECT 1 FROM file_automerge_versions daily
                  WHERE daily.file_id=av.file_id AND daily.document IS NOT NULL
                    AND daily.created_at::date=av.created_at::date
                    AND (daily.created_at,daily.version_id)>(av.created_at,av.version_id)))
            ORDER BY av.created_at, av.version_id
            LIMIT $3 FOR UPDATE SKIP LOCKED
          )
          UPDATE file_automerge_versions av SET document=NULL
          FROM candidates c WHERE av.version_id=c.version_id RETURNING av.version_id`,
          [this.keepRecent, this.dailyDays, this.batchSize]);
          await client.query('COMMIT');
          const count = result.rowCount ?? result.rows.length;
          removed += count;
          if (count < this.batchSize) break;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      }
      return removed;
    } finally { this.running = false; }
  }
}
