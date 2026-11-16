// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** files_database_operation_receipts: one durable receipt per file, folder or create-folder operation. */
export class DatabaseOperationReceiptRepository {
  /** The caller's prior receipt for this idempotency key, with whether it was the same request. */
  async lockPrior(client:Queryable, userId:string, scope:string, key:string, request:string):Promise<any> {
    return (await client.query(`SELECT *,request=$4::jsonb AS same_request FROM files_database_operation_receipts
      WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=$3 FOR UPDATE`, [userId, scope, key, request])).rows[0];
  }

  async findPrior(client:Queryable, userId:string, scope:string, key:string):Promise<any> {
    return (await client.query('SELECT * FROM files_database_operation_receipts WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=$3', [userId, scope, key])).rows[0];
  }

  /** Reserves the receipt identity inside the operation's transaction; rollback removes it. */
  async reserveFile(client:Queryable, userId:string, scope:string, key:string, request:unknown, collectionId:string, fileId:string, action:string, before:unknown):Promise<any> {
    return (await client.query(`INSERT INTO files_database_operation_receipts
      (actor_user_id,actor_scope,idempotency_key,request,collection_id,file_id,action,state,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8,$8) RETURNING *`,
    [userId, scope, key, request, collectionId, fileId, action, before])).rows[0];
  }

  async insertCreateFolder(client:Queryable, userId:string, scope:string, key:string, request:unknown, collectionId:string, state:string, after:string):Promise<any> {
    return (await client.query(`INSERT INTO files_database_operation_receipts(actor_user_id,actor_scope,idempotency_key,request,collection_id,action,state,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,'create-folder',$6,'null'::jsonb,$7::jsonb) RETURNING *`, [userId, scope, key, request, collectionId, state, after])).rows[0];
  }

  async insertFolder(client:Queryable, id:string, userId:string, scope:string, key:string, request:unknown, collectionId:string, action:string, state:string, before:string, displacedBefore:string, displacedAfter:string):Promise<any> {
    return (await client.query(`INSERT INTO files_database_operation_receipts(id,actor_user_id,actor_scope,idempotency_key,request,collection_id,action,state,before_state,after_state,displaced_before,displaced_after)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$9::jsonb,$10::jsonb,$11::jsonb) RETURNING *`, [id, userId, scope, key, request, collectionId, action, state, before, displacedBefore, displacedAfter])).rows[0];
  }

  async setDisplaced(client:Queryable, id:string, before:unknown, after:unknown):Promise<void> {
    await client.query('UPDATE files_database_operation_receipts SET displaced_before=$2,displaced_after=$3 WHERE id=$1', [id, before, after]);
  }

  async complete(client:Queryable, id:string, after:unknown, state:string, plan:unknown):Promise<void> {
    await client.query('UPDATE files_database_operation_receipts SET after_state=$2,state=$3,folder_plan=COALESCE(folder_plan,$4) WHERE id=$1', [id, after, state, plan]);
  }

  async sign(client:Queryable, id:string, signature:string):Promise<any> {
    return (await client.query('UPDATE files_database_operation_receipts SET permission_signature=$2 WHERE id=$1 RETURNING *', [id, signature])).rows[0];
  }

  async signQuietly(client:Queryable, id:string, signature:string):Promise<void> {
    await client.query('UPDATE files_database_operation_receipts SET permission_signature=$2 WHERE id=$1', [id, signature]);
  }

  async completeFolder(client:Queryable, id:string, after:unknown, plan:unknown):Promise<any> {
    return (await client.query('UPDATE files_database_operation_receipts SET after_state=$2,folder_plan=$3 WHERE id=$1 RETURNING *', [id, after, plan])).rows[0];
  }

  async setFolderPlan(client:Queryable, id:string, plan:unknown):Promise<void> {
    await client.query('UPDATE files_database_operation_receipts SET folder_plan=$2 WHERE id=$1', [id, plan]);
  }

  /** Records the disposal invalidation on a child receipt without touching its other lifecycle fields. */
  async invalidateChild(client:Queryable, id:string, invalidation:string):Promise<void> {
    await client.query(`UPDATE files_database_operation_receipts SET folder_plan=COALESCE(folder_plan,'{}'::jsonb)||jsonb_build_object(
      'lifecycle',COALESCE(folder_plan->'lifecycle','{}'::jsonb)||jsonb_build_object('disposal',$2::jsonb)) WHERE id=$1`, [id, invalidation]);
  }

  /** The actor's receipt header, read before the transaction so access can be prepared. */
  async ownedHeader(db:Queryable, id:string, userId:string, scope:string):Promise<{ collection_id:string; request:any } | undefined> {
    return (await db.query('SELECT collection_id,request FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3', [id, userId, scope])).rows[0];
  }

  async lockOwned(client:Queryable, id:string, userId:string, scope:string):Promise<any> {
    return (await client.query('SELECT * FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3 FOR UPDATE', [id, userId, scope])).rows[0];
  }

  async lockById(client:Queryable, id:string):Promise<any> {
    return (await client.query(`SELECT * FROM files_database_operation_receipts WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  }

  async lockSignatureState(client:Queryable, id:string):Promise<any> {
    return (await client.query('SELECT collection_id,state,permission_signature FROM files_database_operation_receipts WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }

  async requestOf(db:Queryable, id:string):Promise<{ request:any } | undefined> {
    return (await db.query('SELECT request FROM files_database_operation_receipts WHERE id=$1', [id])).rows[0];
  }

  async trashCollection(db:Queryable, id:string):Promise<{ collection_id:string } | undefined> {
    return (await db.query(`SELECT collection_id FROM files_database_operation_receipts WHERE id=$1 AND action='trash'`, [id])).rows[0];
  }

  async lockTrash(client:Queryable, id:string):Promise<any> {
    return (await client.query(`SELECT * FROM files_database_operation_receipts WHERE id=$1 AND action='trash' FOR UPDATE`, [id])).rows[0];
  }

  async lockFileTrash(client:Queryable, id:string, fileId:string):Promise<any> {
    return (await client.query(`SELECT * FROM files_database_operation_receipts WHERE id=$1 AND file_id=$2 AND action='trash' FOR UPDATE`, [id, fileId])).rows[0];
  }

  async markUndone(client:Queryable, id:string):Promise<any> {
    return (await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1 RETURNING *", [id])).rows[0];
  }

  async markUndoneQuietly(client:Queryable, id:string):Promise<void> {
    await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1", [id]);
  }

  /** Destinations of a batch's committed items, for re-authorizing a replay. */
  async destinationsByKeys(client:Queryable, userId:string, scope:string, keys:string[]):Promise<any[]> {
    return (await client.query('SELECT after_state,displaced_after FROM files_database_operation_receipts WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=ANY($3::uuid[])', [userId, scope, keys])).rows;
  }

  async byKeys(client:Queryable, keys:string[]):Promise<any[]> {
    return (await client.query('SELECT * FROM files_database_operation_receipts WHERE idempotency_key=ANY($1::uuid[])', [keys])).rows;
  }
}
