// SPDX-License-Identifier: GPL-2.0-or-later
import type pg from 'pg';

import { TransactionRunner } from './FilesTransaction.js';
import { AutomergeSnapshotRepository } from './Repositories/AutomergeSnapshotRepository.js';

const FIRST_FILE = '00000000-0000-0000-0000-000000000000';
// The per-file statement timeout is capped at 5 s, so only a transaction held well past that is slow.
const SLOW_PRUNE_MS = 10_000;

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
  static readonly FILE_PRUNE_SQL = AutomergeSnapshotRepository.FILE_PRUNE_SQL;
  static readonly FILE_SCAN_SQL = AutomergeSnapshotRepository.FILE_SCAN_SQL;

  private running = false;
  private cursor = FIRST_FILE;

  constructor(
    db: Pick<pg.Pool, 'query' | 'connect'>,
    private readonly keepRecent = 50,
    private readonly dailyDays = 30,
    private readonly batchSize = 100,
    private readonly timeBudgetMs = 1_000,
    private readonly fileScanRows = 2_000,
    private readonly snapshots = new AutomergeSnapshotRepository(db),
    private readonly transactions = new TransactionRunner(db, undefined, undefined, SLOW_PRUNE_MS),
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
        const files = await this.snapshots.nextFileIds(this.cursor, this.fileScanRows);
        if (files.length === 0) { this.cursor = FIRST_FILE; break; } // one full lap done; resume next run
        for (const fileId of files) {
          if (remaining() <= 0) return removed;
          // Floor the statement timeout: a sliver of leftover budget would only get the statement cancelled.
          removed += await this.pruneFile(fileId, Math.min(5_000, Math.max(250, remaining())));
          this.cursor = fileId;
        }
      }
      return removed;
    } finally { this.running = false; }
  }

  private pruneFile(fileId:string, budgetMs:number): Promise<number> {
    const policy = { keepRecent: this.keepRecent, dailyDays: this.dailyDays, batchSize: this.batchSize };
    return this.transactions.run('automerge snapshot prune', client => this.snapshots.pruneFile(client, fileId, policy, budgetMs));
  }
}
