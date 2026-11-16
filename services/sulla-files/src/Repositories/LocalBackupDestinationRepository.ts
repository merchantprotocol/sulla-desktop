// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { BackupDestinationConfig } from '../backup/destinations.js';

export interface BackupDestinationRow { id:string; kind:string; label:string; config:BackupDestinationConfig; enabled:boolean; created_at:Date; updated_at:Date }
export interface BackupRunStatusRow { destination_id:string; state:string; started_at:Date; finished_at:Date | null; error_message:string | null; snapshot_id:string | null }

/** The local backup administration API's reads and writes of personal backup destinations (moved from app.ts, SQL verbatim). */
export class LocalBackupDestinationRepository {
  constructor(private readonly db:pg.Pool) {}

  async list():Promise<BackupDestinationRow[]> {
    return (await this.db.query(`SELECT id,kind,label,config,enabled,created_at,updated_at FROM files_backup_destinations ORDER BY created_at`)).rows;
  }

  /** The newest run of every destination. */
  async latestRuns():Promise<BackupRunStatusRow[]> {
    return (await this.db.query(`SELECT DISTINCT ON(destination_id) destination_id,state,started_at,finished_at,error_message,snapshot_id
      FROM files_backup_runs ORDER BY destination_id,started_at DESC`)).rows;
  }

  async create(id:string, kind:string, label:string, destination:BackupDestinationConfig):Promise<BackupDestinationRow> {
    return (await this.db.query(`INSERT INTO files_backup_destinations(id,kind,label,config) VALUES($1,$2,$3,$4) RETURNING *`, [id, kind, label, destination])).rows[0];
  }

  async findEnabled(id:string):Promise<BackupDestinationRow | undefined> {
    return (await this.db.query('SELECT * FROM files_backup_destinations WHERE id::text=$1 AND enabled=TRUE', [id])).rows[0];
  }

  /** Transaction-scoped try-lock on the same key the scheduler holds for a running backup. */
  async tryLockForRemoval(client:pg.PoolClient, id:string):Promise<boolean> {
    return (await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [`files-backup:${ id }`])).rows[0].locked;
  }

  async findForUpdate(client:pg.PoolClient, id:string):Promise<{ id:string; kind:string } | undefined> {
    return (await client.query('SELECT id,kind FROM files_backup_destinations WHERE id::text=$1 FOR UPDATE', [id])).rows[0];
  }

  async remove(client:pg.PoolClient, id:string):Promise<void> {
    await client.query('DELETE FROM files_backup_destinations WHERE id=$1', [id]);
  }
}
