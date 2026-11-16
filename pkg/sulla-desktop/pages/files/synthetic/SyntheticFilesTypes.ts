// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SyntheticCollection, SyntheticFile, SyntheticFolder, SyntheticFolderReceiptPlan, SyntheticMutation, SyntheticOperation, SyntheticState, SyntheticTrashState } from './SyntheticFilesTypes';
import type { FilesFolderState, FilesItem, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry, FilesTrashTombstone, FolderShare } from '../types';

/** In-memory model behind the synthetic /files-preview data source. */
export interface SyntheticTrashState {
  listed:boolean;
  revision:string;
  tombstone:FilesTrashTombstone;
  parentReceiptId?:string;
  purgeOutcome?:'recovery-required';
}
export interface SyntheticFile extends FilesItem { syntheticTrash?:SyntheticTrashState }
export interface SyntheticFolder extends FilesFolderState { deletedAt?:string; syntheticTrash?:SyntheticTrashState }
export interface SyntheticCollection { id:string; name:string; home:string; systemArea:'logs' | 'sulla' | null; files:SyntheticFile[]; folders:SyntheticFolder[]; cloudCatalogSync?:boolean }
export interface SyntheticMutation {
  before:SyntheticCollection[];
  after:SyntheticCollection[];
  beforeFolderShares:FolderShare[];
  afterFolderShares:FolderShare[];
  fileIds:string[];
  folderIds:string[];
  folderShareIds:string[];
}
export interface SyntheticOperation {
  request:FilesOperationRequest;
  fingerprint:string;
  receipt:FilesOperationReceipt;
  mutations:Record<string, SyntheticMutation>;
  retryOverrides:Record<string, NonNullable<FilesOperationRetry['items']>[number]>;
}
export interface SyntheticFolderReceiptPlan {
  collectionId:string;
  rootFolderId:string;
  rootPath:string;
  files:{ id:string; path:string; revision:string; receiptId:string }[];
  folders:{ id:string; path:string; revision:string }[];
}
export interface SyntheticState {
  revision:number;
  sequence:number;
  selectedCollectionId:string;
  collections:SyntheticCollection[];
  operations:Record<string, SyntheticOperation>;
  idempotency:Record<string, { fingerprint:string; operationId:string }>;
  folderReceipts:Record<string, SyntheticFolderReceiptPlan>;
  stars:Record<string, string[]>;
  folderShares:FolderShare[];
  staleReplaceAdvanced:boolean;
}
