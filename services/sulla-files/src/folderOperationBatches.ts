// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Legacy entry points kept for app.ts until the composition root injects DatabaseOperationServices.
// The implementation lives in Services/Folder*.ts and Repositories/.
import type pg from 'pg';
import type { FilesIdentity } from './auth.js';
import type { DatabaseOperationAccess } from './Services/DatabaseOperationTypes.js';
import { DatabaseOperationServices } from './Services/DatabaseOperationServices.js';
import type { FolderPurgeInput } from './Services/FolderTrashService.js';

export const folderOperationState = (db:pg.Pool, collectionId:string, path:string, access:DatabaseOperationAccess) =>
  DatabaseOperationServices.forPool(db).inspector.displayState(collectionId, path, access);

export const restoreTrashedFolder = (db:pg.Pool, folderId:string, receiptId:string, expectedRevision:string, actor:FilesIdentity, access:DatabaseOperationAccess) =>
  DatabaseOperationServices.forPool(db).folderTrash.restore(folderId, receiptId, expectedRevision, actor, access);

export const purgeTrashedFolder = (db:pg.Pool, folderId:string, receiptId:string, expectedRevision:string, actor:FilesIdentity, access:DatabaseOperationAccess, input:FolderPurgeInput):Promise<any> =>
  DatabaseOperationServices.forPool(db).folderTrash.purge(folderId, receiptId, expectedRevision, actor, access, input);
