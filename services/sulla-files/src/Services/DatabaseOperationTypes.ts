// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface DatabaseOperationRequest {
  idempotencyKey:string;
  collectionId:string;
  targetCollectionId?:string;
  action:'move' | 'copy' | 'rename' | 'trash';
  fileId:string;
  expectedVersionId:string;
  expectedRevision:string;
  targetPath?:string;
  collisionPolicy?:'replace' | 'keep-both' | 'skip';
  expectedDestination?:DatabaseOperationState;
}
/** In-process authority only: Symbol keys cannot arrive over JSON or persist in receipt JSONB. */
export const folderGrantMigration = Symbol('folderGrantMigration');
export type InternalDatabaseOperationRequest = DatabaseOperationRequest & { [folderGrantMigration]?:true; parentFollows?:boolean };
export interface DatabaseOperationState {
  collectionId?:string;
  fileId:string;
  path:string;
  versionId:string;
  revision:string;
  deleted:boolean;
}
export interface DatabaseOperationReceipt {
  operationId:string;
  collectionId:string;
  action:DatabaseOperationRequest['action'];
  state:'completed' | 'skipped' | 'undone';
  undoSupported:boolean;
  before:DatabaseOperationState;
  after:DatabaseOperationState;
  createdAt:string;
  undoneAt:string | null;
  displacedBefore?:DatabaseOperationState;
  displacedAfter?:DatabaseOperationState;
}
export interface TrashRestoreRequest {
  expectedVersionId?:string;
  expectedRevision?:string;
  receiptId?:string;
}
export interface TrashRestoreResult {
  status:'restored'; kind:'file'; id:string; path:string; revision:string;
  currentTombstone:null; receiptId:string|null; versionId:string;
}
export interface DatabaseOperationAccess {
  custody?: {
    run<T>(operation:()=>Promise<T>):Promise<T>;
    publish(client:pg.PoolClient,receipt:any,undo:boolean):Promise<void>;
    occupied(collectionId:string,path:string):Promise<boolean>;
    folders(collectionId:string,path:string,files:string[]):Promise<string[]>;
    folderSnapshot(collectionId:string,path:string,files:string[]):Promise<{directories:string[];nativeSignature:string}>;
    available():Promise<boolean>;
  };
  prepare?(collectionId:string):Promise<void>;
  file(client:pg.PoolClient, fileId:string):Promise<any>;
  path(client:pg.PoolClient, collectionId:string, path:string):Promise<unknown>;
}
/** Re-checked inside every item/undo transaction before it changes anything. */
export type OperationGuard = (client:pg.PoolClient)=>Promise<void>;
/** Internal undo authority granted by a containing folder receipt. */
export interface UndoAuthority {
  folderGrantMigration?:true;
  parentFollows?:true;
  /** A containing folder receipt verified this signature before relocating only its recorded grants. */
  permissionSignatureVerified?:true;
}

/** Maps file rows and receipt rows to the API's receipt shapes. */
export class OperationRecords {
  static snapshot(file:any):DatabaseOperationState {
    return {
      collectionId: file.collection_id,
      fileId: file.id, path: file.path, versionId: file.current_version_id,
      revision: String(file.operation_revision), deleted: Boolean(file.deleted_at),
    };
  }

  static receipt(row:any):DatabaseOperationReceipt {
    return {
      operationId: row.id, collectionId: row.collection_id, action: row.action, state: row.state,
      undoSupported: row.state === 'completed', before: row.before_state, after: row.after_state,
      createdAt: row.created_at.toISOString(), undoneAt: row.undone_at?.toISOString() ?? null,
      ...(row.displaced_before ? { displacedBefore: row.displaced_before, displacedAfter: row.displaced_after } : {}),
    };
  }

  /** The state recorded as a receipt's `after`, normalized to compare with a live snapshot. */
  static expected(state:DatabaseOperationState, collectionId:string):DatabaseOperationState {
    return { collectionId: state.collectionId ?? collectionId, fileId: state.fileId, path: state.path, versionId: state.versionId, revision: state.revision, deleted: state.deleted };
  }
}
