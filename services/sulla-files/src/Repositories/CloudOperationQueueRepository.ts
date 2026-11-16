// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { CloudOp, QueuedOperation } from '../cloudSync/repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Device-signed Cloud calls waiting for main to sign (files_cloud_operations), oldest first. */
export class PgCloudOperationQueueRepository {
  constructor(private readonly db:pg.Pool) {}

  async queue(collectionId:string, op:CloudOp, path:string, method:string, body:string | null, sha256:string, handle:string, meta:Record<string, unknown> = {}):Promise<void> {
    await this.db.query(`INSERT INTO files_cloud_operations(handle,collection_id,op,path,method,body,sha256,meta)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [handle, collectionId, op, path, method, body, sha256, meta]);
  }

  /** The oldest queued call of an enabled collection; a `delete` still runs after backup was switched off. */
  async nextOperation():Promise<QueuedOperation | null> {
    const row = (await this.db.query(`SELECT o.* FROM files_cloud_operations o JOIN files_cloud_sync s ON s.collection_id=o.collection_id
      WHERE s.enabled=TRUE OR o.op='delete' ORDER BY o.created_at,o.handle LIMIT 1`)).rows[0];
    return row ? this.operation(row) : null;
  }

  async hasOperation(collectionId:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM files_cloud_operations WHERE collection_id=$1 LIMIT 1', [collectionId])).rowCount);
  }

  async operationByHandle(handle:string):Promise<QueuedOperation | null> {
    if (!UUID.test(handle)) return null;
    const row = (await this.db.query('SELECT * FROM files_cloud_operations WHERE handle=$1', [handle])).rows[0];
    return row ? this.operation(row) : null;
  }

  async completeOperation(handle:string):Promise<void> {
    await this.db.query('DELETE FROM files_cloud_operations WHERE handle=$1', [handle]);
  }

  /** Counts one more failed attempt and returns the new total. */
  async failOperation(handle:string, error:string):Promise<number> {
    const row = (await this.db.query('UPDATE files_cloud_operations SET attempts=attempts+1,last_error=$2 WHERE handle=$1 RETURNING attempts', [handle, error])).rows[0];
    return Number(row?.attempts ?? 0);
  }

  async dropCollectionOperations(collectionId:string, ops:CloudOp[]):Promise<void> {
    await this.db.query('DELETE FROM files_cloud_operations WHERE collection_id=$1 AND op=ANY($2::text[])', [collectionId, ops]);
  }

  private operation(row:any):QueuedOperation {
    return {
      handle: String(row.handle),
      collectionId: String(row.collection_id),
      op: row.op,
      path: row.path,
      method: row.method,
      body: row.body ?? null,
      sha256: row.sha256,
      meta: row.meta ?? {},
      attempts: Number(row.attempts ?? 0),
    };
  }
}
