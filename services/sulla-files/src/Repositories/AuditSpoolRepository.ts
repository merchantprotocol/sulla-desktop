// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface AuditSpoolRow { id:string | number; event:any; created_at:Date | string; last_error?:string | null }
export interface AuditLogFileRow { id:string; current_version_id:string | null }

/**
 * The audit retry spool and the Logs-collection rows FileAuditWriter appends to. Reads before
 * the delivery transaction go through the pool given to the constructor; the re-checks inside
 * the transaction take the transaction's client.
 */
export class AuditSpoolRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** Spools one validated service audit event for delivery. */
  async enqueue(event:unknown):Promise<void> {
    await this.db.query('INSERT INTO files_audit_spool(event) VALUES($1)', [event]);
  }

  /** The oldest pending audit event (delivery order is spool id order). */
  async nextPending():Promise<AuditSpoolRow | undefined> {
    return (await this.db.query('SELECT * FROM files_audit_spool ORDER BY id LIMIT 1')).rows[0];
  }

  async findLogsCollectionId():Promise<string | undefined> {
    return (await this.db.query("SELECT id FROM collections WHERE system_area='logs'")).rows[0]?.id;
  }

  async findLogFile(collectionId:string, path:string):Promise<AuditLogFileRow | undefined> {
    return (await this.db.query('SELECT id,current_version_id FROM files WHERE collection_id=$1 AND path=$2', [collectionId, path])).rows[0];
  }

  /** Records why delivery failed; the event stays queued for the next drain. */
  async recordFailure(eventId:string, message:string):Promise<void> {
    await this.db.query('UPDATE files_audit_spool SET last_error=$2 WHERE id=$1', [eventId, message]);
  }

  /** One delivery lock preserves ordering, including across multiple service instances. */
  async tryDeliveryLock(client:pg.PoolClient):Promise<boolean> {
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('files-audit-delivery',0)) locked");
    return Boolean(lock.rows[0]?.locked);
  }

  /** Locks the spool row; false when another delivery already removed it. */
  async lockPending(client:pg.PoolClient, id:string | number):Promise<boolean> {
    return Boolean((await client.query('SELECT id FROM files_audit_spool WHERE id=$1 FOR UPDATE', [id])).rowCount);
  }

  async lockLogFile(client:pg.PoolClient, collectionId:string, path:string):Promise<AuditLogFileRow | undefined> {
    return (await client.query('SELECT id,current_version_id FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE', [collectionId, path])).rows[0];
  }

  async deletePending(client:pg.PoolClient, id:string | number):Promise<void> {
    await client.query('DELETE FROM files_audit_spool WHERE id=$1', [id]);
  }
}
