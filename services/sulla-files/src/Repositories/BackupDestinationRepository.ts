// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BackupDestinationConfig } from '../backup/destinations.js';
import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

export interface EnabledBackupDestination { id:string; config:BackupDestinationConfig }

/** Personal backup destinations and the per-destination session lock that serializes runs. */
export class BackupDestinationRepository {
  async listEnabled(db:Queryable):Promise<EnabledBackupDestination[]> {
    return (await db.query('SELECT id,config FROM files_backup_destinations WHERE enabled=TRUE ORDER BY id')).rows as EnabledBackupDestination[];
  }

  async isEnabled(client:Queryable, destinationId:string):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM files_backup_destinations WHERE id=$1 AND enabled=TRUE', [destinationId])).rowCount);
  }

  /** Session-level lock held on the run's dedicated client for the whole backup. */
  async tryLock(client:pg.PoolClient, destinationId:string):Promise<boolean> {
    return ((await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`files-backup:${ destinationId }`])).rows as { locked:boolean }[])[0].locked;
  }

  async unlock(client:pg.PoolClient, destinationId:string):Promise<void> {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`files-backup:${ destinationId }`]);
  }
}
