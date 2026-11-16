// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DatabaseOperationRequest, DatabaseOperationState } from './DatabaseOperationTypes.js';

export type DatabaseCollisionPolicy = 'replace'|'keep-both'|'skip';
export type DatabaseBatchState = 'pending'|'completed'|'partial'|'failed'|'cancelled'|'undone';
export type DatabaseItemState = 'pending'|'completed'|'skipped'|'failed'|'cancelled'|'undone';
export interface DatabaseFolderState { collectionId?:string; folderId?:string; path:string; revision?:string; subtreeSignature?:string }
interface DatabaseBatchItemBase extends Omit<DatabaseOperationRequest,'idempotencyKey'|'collectionId'|'action'|'fileId'|'expectedVersionId'|'expectedRevision'|'expectedDestination'> {
  itemId:string;
  action:'move'|'copy'|'rename'|'trash'|'create-folder';
  fileId?:string; expectedVersionId?:string; expectedRevision?:string;
  kind?:'file'|'folder'; folderPath?:string; expectedFolder?:DatabaseFolderState; sourceSubtreeSignature?:string; targetCollectionId?:string;
}
export interface DatabaseFileBatchItem extends DatabaseBatchItemBase {
  kind?:'file'; action:'move'|'copy'|'rename'|'trash';
  fileId:string; expectedVersionId:string; expectedRevision:string;
  expectedDestination?:DatabaseOperationState;
  folderPath?:never; expectedFolder?:never; sourceSubtreeSignature?:never;
}
export interface DatabaseFolderBatchItem extends DatabaseBatchItemBase {
  kind:'folder'; action:'move'|'copy'|'rename'|'trash'; folderPath:string;
  fileId?:never; expectedVersionId?:never; expectedRevision?:never;
  collisionPolicy?:DatabaseCollisionPolicy;
  expectedDestination?:DatabaseFolderState;
}
export interface DatabaseCreateFolderBatchItem extends DatabaseBatchItemBase {
  kind?:'file'; action:'create-folder'; targetPath:string;
  fileId?:never; expectedVersionId?:never; expectedRevision?:never; folderPath?:never; expectedFolder?:never; sourceSubtreeSignature?:never;
  collisionPolicy?:'keep-both'|'skip';
}
export type DatabaseBatchItem=DatabaseFileBatchItem|DatabaseFolderBatchItem|DatabaseCreateFolderBatchItem;
export interface DatabaseBatchRequest { idempotencyKey:string; collectionId:string; items:DatabaseBatchItem[] }
export interface DatabaseRetryRequest { items?:{ itemId:string; collisionPolicy?:DatabaseCollisionPolicy; expectedDestination?:DatabaseOperationState|DatabaseFolderState }[] }
export interface DatabaseItemError { status:number; code:string; message:string; destination?:DatabaseOperationState|DatabaseFolderState }
export interface DatabaseBatchItemReceipt {
  itemId:string; action:DatabaseBatchItem['action']; state:DatabaseItemState; receiptId:string|null;
  before:DatabaseOperationState|DatabaseFolderState|null; after:DatabaseOperationState|DatabaseFolderState|null;
  displacedBefore?:DatabaseOperationState|DatabaseFolderState; displacedAfter?:DatabaseOperationState|DatabaseFolderState;
  error:DatabaseItemError|null; undoSupported:boolean; retryable:boolean;
}
export interface DatabaseBatchReceipt {
  operationId:string; collectionId:string; state:DatabaseBatchState; cancelRequested:boolean;
  undoSupported:boolean; retryable:boolean; createdAt:string; updatedAt:string; items:DatabaseBatchItemReceipt[];
}
/** A folder batch item as executed: the item plus the batch's collection, item key and operation id. */
export type FolderBatchExecution = DatabaseBatchItem & { collectionId:string;idempotencyKey:string;batchOperationId?:string };
