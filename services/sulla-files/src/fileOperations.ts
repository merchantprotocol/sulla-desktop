// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Legacy entry points kept for app.ts, NativePathOperationPublisher.ts and the Desktop spec until the composition
// root injects StoredFileOperationService. The implementation lives in Services/ and Repositories/.
import type pg from 'pg';
import type { FilesIdentity } from './auth.js';
import { StoredFileCopier, StoredFileOperationService, type StoredFolderMove } from './Services/StoredFileOperationService.js';
import { TransactionRunner } from './FilesTransaction.js';

export { FileOperationConflict } from './Services/StoredFileOperationService.js';

export interface FileOperationItem { fileId?:string; folderPath?:string; targetPath:string }

/** Copy inside the caller's open transaction; never starts its own. */
export const copyLockedFile = (client:pg.PoolClient, source:any, targetPath:string, actor:FilesIdentity):Promise<any> =>
  new StoredFileCopier().copy(client, source, targetPath, actor);

export const applyDatabaseFileOperations = (db:pg.Pool, action:'move' | 'copy', sources:{ file:any; targetPath:string }[], actor:FilesIdentity, folderMoves:StoredFolderMove[] = []):Promise<any[]> =>
  new StoredFileOperationService(new TransactionRunner(db)).apply(action, sources, actor, folderMoves);
