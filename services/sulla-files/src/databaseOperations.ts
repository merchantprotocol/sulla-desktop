// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Legacy entry points kept for callers outside the dbops slice (app.ts, the Desktop spec).
// The implementation lives in Services/ (TrashRestoreService et al.) and Repositories/.
import type pg from 'pg';
import type { FilesIdentity } from './auth.js';
import { DatabaseOperationServices } from './Services/DatabaseOperationServices.js';
import type { DatabaseOperationAccess, TrashRestoreRequest, TrashRestoreResult } from './Services/DatabaseOperationTypes.js';

export { folderGrantMigration } from './Services/DatabaseOperationTypes.js';
export type { DatabaseOperationAccess, DatabaseOperationReceipt, DatabaseOperationRequest, DatabaseOperationState,
  TrashRestoreRequest, TrashRestoreResult } from './Services/DatabaseOperationTypes.js';

export const restoreTrashedFile = (db:pg.Pool, fileId:string, actor:FilesIdentity, access:DatabaseOperationAccess, request:TrashRestoreRequest = {}):Promise<TrashRestoreResult> =>
  DatabaseOperationServices.forPool(db).trash.restoreFile(fileId, actor, access, request);

export const trashFileWithoutReceipt = (db:pg.Pool, fileId:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<void> =>
  DatabaseOperationServices.forPool(db).trash.trashWithoutReceipt(fileId, actor, access);
