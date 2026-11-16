// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { FilesIdentity } from '../auth.js';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** Change-journal and audit-log rows written by receipt, Trash and folder operations. */
export class OperationAuditRepository {
  private whoType(actor:FilesIdentity):string { return actor.kind === 'capability' ? 'agent-or-device' : 'user' }

  /** One journal row plus its database-operation audit row for a changed file. */
  async recordFileOperation(client:Queryable, actor:FilesIdentity, file:any, op:'put' | 'delete' | 'rename' | 'restore', operationId:string):Promise<void> {
    await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [file.collection_id, file.id, file.current_version_id, op]);
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [this.whoType(actor), actor.userId, actor.deviceId || null, file.id, file.current_version_id, 'database-operation-' + op, { operationId }]);
  }

  async journalRestore(client:Queryable, collectionId:string, fileId:string, versionId:string):Promise<void> {
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'restore')", [collectionId, fileId, versionId]);
  }

  async journalDelete(client:Queryable, collectionId:string, fileId:string, versionId:string):Promise<void> {
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [collectionId, fileId, versionId]);
  }

  async createFolder(client:Queryable, actor:FilesIdentity, details:unknown):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user',$1,'create-folder',$2)`, [actor.userId, details]);
  }

  async undoCreateFolder(client:Queryable, actor:FilesIdentity, details:unknown):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user',$1,'undo-create-folder',$2)`, [actor.userId, details]);
  }

  async folderOperation(client:Queryable, actor:FilesIdentity, details:unknown):Promise<void> {
    await client.query("INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user',$1,'folder-operation',$2)", [actor.userId, details]);
  }

  async trashRestore(client:Queryable, actor:FilesIdentity, fileId:string, versionId:string, details:unknown):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES($1,$2,$3,$4,$5,'trash-restore',$6)`, [this.whoType(actor), actor.userId, actor.deviceId || null, fileId, versionId, details]);
  }

  async trash(client:Queryable, actor:FilesIdentity, fileId:string, versionId:string, details:unknown):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES($1,$2,$3,$4,$5,'trash',$6)`, [this.whoType(actor), actor.userId, actor.deviceId || null, fileId, versionId, details]);
  }

  async trashRestoreFolder(client:Queryable, actor:FilesIdentity, details:unknown):Promise<void> {
    await client.query("INSERT INTO audit_log(who_type,who_id,device_or_run_id,action,details) VALUES($1,$2,$3,'trash-restore-folder',$4)", [this.whoType(actor), actor.userId, actor.deviceId || null, details]);
  }

  async folderDisposalPurge(client:Queryable, actor:FilesIdentity, details:unknown):Promise<{ id:string }> {
    return (await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,action,details) VALUES($1,$2,$3,'folder-disposal-purge',$4) RETURNING id`,
      [this.whoType(actor), actor.userId, actor.deviceId || null, details])).rows[0];
  }
}
