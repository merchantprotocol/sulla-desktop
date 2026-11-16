// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesItem, FilesItemCapabilities } from './filesItemTypes';

export type FilesRevealResult =
  | { status:'revealed'; target:'tracked-original' | 'materialized-copy'; fileId:string; versionId:string }
  | { status:'unavailable'; code:'no-local-copy' | 'local-copy-changed'; reason:string };

export type FilesCollisionPolicy = 'replace' | 'keep-both' | 'skip';
export type FilesCrossCollectionCapability = 'all-authorized' | 'stored-authorized' | 'unavailable';
export interface FilesOperationCapabilities {
  enabled:boolean;
  reason?:string;
  folderReceipts:boolean;
  nativeFolderReceipts:boolean;
  folderCollisionPolicies:FilesCollisionPolicy[];
  crossCollectionOperations:FilesCrossCollectionCapability;
}
export interface FilesFolderState { collectionId?:string; folderId:string; path:string; revision:string; description?:string|null; namingHint?:string|null; needsDescription?:boolean }
export interface FilesFolderSummary { path:string; name:string; fileCount:number; totalBytes:number; updatedAt:string|null }
export interface FilesFolderSourceSnapshot {
  collectionId:string;
  path:string;
  folderId?:string;
  revision?:string;
  subtreeSignature:string;
}
export interface FilesFolderReplacementDestination extends FilesFolderState { subtreeSignature:string }
export function isFilesFolderState(value:unknown):value is FilesFolderState {
  if (!value || typeof value !== 'object') return false;
  const state=value as Record<string, unknown>;

  return !('fileId' in state) && typeof state.folderId === 'string' && typeof state.path === 'string' && typeof state.revision === 'string' &&
    (state.collectionId === undefined || typeof state.collectionId === 'string');
}
export type FilesTrashUndoState = 'available' | 'invalidated' | 'recovery-required' | 'unavailable';
export interface FilesTrashUndo { state:FilesTrashUndoState; expiresAt?:string }
export type FilesTrashTombstone =
  | { kind:'version'; id:string; receiptId?:string; operationId?:string; undo:FilesTrashUndo }
  | { kind:'receipt'; id:string; receiptId:string; operationId?:string; undo:FilesTrashUndo };
export interface FilesTrashFile extends FilesItem {
  kind:'file';
  revision:string;
  currentTombstone:Extract<FilesTrashTombstone, { kind:'version' }>;
}
export interface FilesTrashFolder {
  kind:'folder';
  id:string;
  path:string;
  revision:string;
  deletedAt:string;
  currentTombstone:Extract<FilesTrashTombstone, { kind:'receipt' }>;
  capabilities?:FilesItemCapabilities;
}
export type FilesTrashItem = FilesTrashFile | FilesTrashFolder;
export type FilesTrashRestoreResult = {
  status:'restored'; kind:FilesTrashItem['kind']; id:string; path:string; revision:string;
  currentTombstone:null; receiptId:string | null; versionId?:string;
};
export type FilesTrashPurgeResult =
  | { status:'purged'; metadataPurged:true; chunks:'complete'; retainedArtifacts:'none' | 'complete'; undo:'invalidated' | 'unavailable'; receiptId:string | null }
  | { status:'recovery-required'; metadataPurged:true; chunks:'pending' | 'complete'; retainedArtifacts:'preserved' | 'complete'; undo:'invalidated' | 'unavailable'; receiptId:string | null; reason?:string }
  | { status:'purged'; kind:'folder'; id:string; path:string; revision:string; currentTombstone:null; metadataPurged:true; chunks?:'complete'; retainedArtifacts:'none' | 'complete'; undo:'invalidated'; receiptId:string }
  | { status:'recovery-required'; kind:'folder'; id:string; path:string; revision:string; currentTombstone:null; metadataPurged:true; chunks?:'pending' | 'complete'; retainedArtifacts:'preserved' | 'complete'; undo:'invalidated'; receiptId:string; reason?:string };
export interface FilesOperationState { collectionId?:string; fileId:string; path:string; versionId:string; revision:string; deleted:boolean }
export type FilesCollisionDestination = FilesOperationState | FilesFolderReplacementDestination;
export function isFilesOperationState(value:unknown):value is FilesOperationState {
  if (!value || typeof value !== 'object') return false;
  const state=value as Record<string, unknown>;

  return !('folderId' in state) && typeof state.fileId === 'string' && typeof state.path === 'string' && typeof state.versionId === 'string' &&
    typeof state.revision === 'string' && typeof state.deleted === 'boolean' &&
    (state.collectionId === undefined || typeof state.collectionId === 'string');
}
export function isFilesFolderReplacementDestination(value:unknown):value is FilesFolderReplacementDestination {
  if (!isFilesFolderState(value)) return false;
  const state=value as FilesFolderReplacementDestination;

  return typeof state.subtreeSignature === 'string' && /^[0-9a-f]{64}$/.test(state.subtreeSignature);
}
export interface FilesOperationItem {
  itemId:string;
  action:'move' | 'copy' | 'rename' | 'trash' | 'create-folder';
  kind?:'file' | 'folder';
  fileId?:string;
  folderPath?:string;
  expectedFolder?:FilesFolderState;
  expectedVersionId?:string;
  expectedRevision?:string;
  targetPath?:string;
  targetCollectionId?:string;
  sourceSubtreeSignature?:string;
  collisionPolicy?:FilesCollisionPolicy;
  expectedDestination?:FilesCollisionDestination;
}
export interface FilesOperationRequest { idempotencyKey:string; collectionId:string; items:FilesOperationItem[] }
export interface FilesOperationRetry { items?:{ itemId:string; collisionPolicy?:FilesCollisionPolicy; expectedDestination?:FilesCollisionDestination }[] }
export interface FilesOperationItemReceipt {
  itemId:string;
  action:FilesOperationItem['action'];
  state:'pending' | 'completed' | 'skipped' | 'failed' | 'cancelled' | 'undone';
  receiptId:string | null;
  before:FilesOperationState | FilesFolderState | null;
  after:FilesOperationState | FilesFolderState | null;
  displacedBefore?:FilesOperationState | FilesFolderState;
  displacedAfter?:FilesOperationState | FilesFolderState;
  error:{ status:number; code:string; message:string; destination?:FilesCollisionDestination } | null;
  undoSupported:boolean;
  retryable:boolean;
}
export interface FilesOperationReceipt {
  operationId:string;
  collectionId:string;
  state:'pending' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'undone';
  cancelRequested:boolean;
  undoSupported:boolean;
  retryable:boolean;
  createdAt:string;
  updatedAt:string;
  items:FilesOperationItemReceipt[];
}
