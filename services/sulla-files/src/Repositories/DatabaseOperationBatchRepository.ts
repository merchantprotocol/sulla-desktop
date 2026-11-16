// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** files_database_operation_batches rows and the native journal rows that belong to a batch. */
export class DatabaseOperationBatchRepository {
  async find(client:Queryable, id:string, lock:boolean):Promise<any> {
    return (await client.query('SELECT * FROM files_database_operation_batches WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])).rows[0];
  }

  /** The batch's collections, read before the transaction so access can be prepared. */
  async header(db:Queryable, id:string):Promise<{ collection_id:string; request:any } | undefined> {
    return (await db.query('SELECT collection_id,request FROM files_database_operation_batches WHERE id=$1', [id])).rows[0];
  }

  async lockPrior(client:Queryable, userId:string, scope:string, key:string, request:unknown):Promise<any> {
    return (await client.query('SELECT *,request=$4::jsonb AS same_request FROM files_database_operation_batches WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=$3 FOR UPDATE', [userId, scope, key, request])).rows[0];
  }

  async insert(client:Queryable, userId:string, scope:string, key:string, collectionId:string, request:unknown, itemKeys:Record<string, string>):Promise<any> {
    return (await client.query(`INSERT INTO files_database_operation_batches(actor_user_id,actor_scope,idempotency_key,collection_id,request,item_keys)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [userId, scope, key, collectionId, request, itemKeys])).rows[0];
  }

  async touch(client:Queryable, id:string):Promise<void> {
    await client.query('UPDATE files_database_operation_batches SET updated_at=NOW() WHERE id=$1', [id]);
  }

  async setItemError(client:Queryable, id:string, itemId:string, error:unknown):Promise<void> {
    await client.query('UPDATE files_database_operation_batches SET errors=jsonb_set(errors,ARRAY[$2],$3::jsonb),updated_at=NOW() WHERE id=$1', [id, itemId, error]);
  }

  async clearItemError(client:Queryable, id:string, itemId:string):Promise<void> {
    await client.query('UPDATE files_database_operation_batches SET errors=errors-$2,updated_at=NOW() WHERE id=$1', [id, itemId]);
  }

  async saveControl(client:Queryable, id:string, cancelled:boolean, errors:unknown, overrides:unknown):Promise<any> {
    return (await client.query('UPDATE files_database_operation_batches SET cancelled=$2,errors=$3,overrides=$4,updated_at=NOW() WHERE id=$1 RETURNING *', [id, cancelled, errors, overrides])).rows[0];
  }

  /** Native journal rows (plan versions 2 and 3) that this batch's items started. */
  async nativeRows(client:Queryable, id:string):Promise<any[]> {
    return (await client.query(`SELECT operation_id,state,plan,plan->>'itemId' AS item_id,last_error FROM files_path_operations
    WHERE plan->>'operationId'=$1 AND plan->>'version' IN('2','3')`, [id])).rows;
  }
}
