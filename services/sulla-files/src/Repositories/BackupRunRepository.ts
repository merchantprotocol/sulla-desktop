// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

/** The run history shown in Settings; one row per backup attempt. */
export class BackupRunRepository {
  /** Only safe while holding the destination lock: that proves the previous owner is gone. */
  async failInterrupted(client:Queryable, destinationId:string):Promise<void> {
    await client.query(`UPDATE files_backup_runs SET state='failed',finished_at=NOW(),error_code='interrupted',error_message='Backup interrupted by service restart' WHERE destination_id=$1 AND state='running'`, [destinationId]);
  }

  async start(client:Queryable, runId:string, destinationId:string):Promise<void> {
    await client.query(`INSERT INTO files_backup_runs(id,destination_id,state) VALUES($1,$2,'running')`, [runId, destinationId]);
  }

  async markVerified(client:Queryable, runId:string, snapshotId:string):Promise<void> {
    await client.query(`UPDATE files_backup_runs SET state='verified',finished_at=NOW(),snapshot_id=$2 WHERE id=$1`, [runId, snapshotId]);
  }

  /** State of the most recent other run for this destination, used to alert only on the first failure. */
  async previousState(client:Queryable, destinationId:string, runId:string):Promise<string | undefined> {
    return ((await client.query(`SELECT state FROM files_backup_runs WHERE destination_id=$1 AND id<>$2 ORDER BY started_at DESC LIMIT 1`, [destinationId, runId])).rows as { state:string }[])[0]?.state;
  }

  async markFailed(client:Queryable, runId:string, message:string):Promise<void> {
    await client.query(`UPDATE files_backup_runs SET state='failed',finished_at=NOW(),error_code='backup-failed',error_message=$2 WHERE id=$1`, [runId, message]);
  }

  async detachSnapshot(client:Queryable, snapshotId:string):Promise<void> {
    await client.query('UPDATE files_backup_runs SET snapshot_id=NULL WHERE snapshot_id=$1', [snapshotId]);
  }
}
