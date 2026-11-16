// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Legacy entry points kept for app.ts until the composition root injects DatabaseOperationServices.
// The implementation lives in Services/DatabaseBatchService.ts and Repositories/.
import type pg from 'pg';
import type { FilesIdentity } from './auth.js';
import type { DatabaseBatchReceipt, DatabaseBatchRequest } from './Services/DatabaseBatchTypes.js';
import { DatabaseBatchRequestParser } from './Services/DatabaseBatchRequestParser.js';
import { DatabaseOperationServices } from './Services/DatabaseOperationServices.js';
import type { DatabaseOperationAccess } from './Services/DatabaseOperationTypes.js';

export type { DatabaseBatchItem, DatabaseBatchItemReceipt, DatabaseBatchReceipt, DatabaseBatchRequest, DatabaseBatchState, DatabaseCollisionPolicy,
  DatabaseCreateFolderBatchItem, DatabaseFileBatchItem, DatabaseFolderBatchItem, DatabaseFolderState, DatabaseItemError, DatabaseItemState,
  DatabaseRetryRequest } from './Services/DatabaseBatchTypes.js';

export const parseDatabaseBatch = (value:any):DatabaseBatchRequest => new DatabaseBatchRequestParser().parse(value);

export const databaseOperationCapabilities = (db:pg.Pool, collectionId:string, access:DatabaseOperationAccess) =>
  DatabaseOperationServices.forPool(db).batches.capabilities(collectionId, access);

export const submitDatabaseBatch = (db:pg.Pool, input:DatabaseBatchRequest, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> =>
  DatabaseOperationServices.forPool(db).batches.submit(input, actor, access);

export const getDatabaseBatch = (db:pg.Pool, id:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> =>
  DatabaseOperationServices.forPool(db).batches.get(id, actor, access);

export const runDatabaseBatch = (db:pg.Pool, id:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<void> =>
  DatabaseOperationServices.forPool(db).batches.run(id, actor, access);

export const controlDatabaseBatch = (db:pg.Pool, id:string, action:'cancel'|'retry'|'undo', body:any, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> =>
  DatabaseOperationServices.forPool(db).batches.control(id, action, body, actor, access);
