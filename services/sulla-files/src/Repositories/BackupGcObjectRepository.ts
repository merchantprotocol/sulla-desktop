// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

/** Durable queue of backup objects awaiting deletion, so a crash mid-prune never loses track of them. */
export class BackupGcObjectRepository {
  async enqueue(client:Queryable, destinationId:string, objectKey:string):Promise<void> {
    await client.query('INSERT INTO files_backup_gc_objects(destination_id,object_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [destinationId, objectKey]);
  }

  async pending(client:Queryable, destinationId:string):Promise<string[]> {
    return ((await client.query('SELECT object_key FROM files_backup_gc_objects WHERE destination_id=$1', [destinationId])).rows as { object_key:string }[]).map(row => row.object_key);
  }

  async remove(client:Queryable, destinationId:string, objectKey:string):Promise<void> {
    await client.query('DELETE FROM files_backup_gc_objects WHERE destination_id=$1 AND object_key=$2', [destinationId, objectKey]);
  }
}
