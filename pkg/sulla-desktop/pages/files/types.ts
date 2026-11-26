// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// The Files renderer contract. Value and entity types live in themed modules and are re-exported
// here so every importer keeps using './types'.
import type { FilesIndexCoverage, FilesItem, FilesItemCapabilities, FilesPreview, FilesRetentionPolicy, FilesSnapshot, FilesVersion, FilesVersioningSettings } from './filesItemTypes';
import type { FilesCollisionPolicy, FilesCrossCollectionCapability, FilesFolderSourceSnapshot, FilesFolderSummary, FilesOperationCapabilities, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry, FilesRevealResult, FilesTrashItem, FilesTrashPurgeResult, FilesTrashRestoreResult } from './filesOperationTypes';
import type { FileAccessList, FileShare, FilesSaveRequest, FilesSaveSuccess, FolderShare, ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType } from './filesSharingTypes';

export * from './filesItemTypes';
export * from './filesOperationTypes';
export * from './filesSharingTypes';

export interface RecordingSegment { start:number; end:number; text:string }
export interface RecordingChapter { start:number; end:number; title:string }
export interface FilesDetail {
  collectionId?: string;
  item?: FilesItem;
  capabilities?: FilesItemCapabilities;
  provenance: { type:string; id:string };
  version: FilesVersion;
  recording?: { version_id:string; language?:string; transcript:RecordingSegment[]; chapters:RecordingChapter[]; duration_seconds?:number; generator?:string; generated_at?:string };
  links: { id:string; path:string; mime:string; kind:'links_to' | 'created_by' | 'derived_from'; direction:'incoming' | 'outgoing'; createdAt:string }[];
  activity: { id:string; who_type:string; who_id:string; device_or_run_id?:string; action:string; at:string; version_id?:string|null; message?:string|null; details?:Record<string, unknown> }[];
  access: { role?:string; inherited:{ id:string; folder_path:string; principal_type:SharePrincipalType; principal_id:string; role:'view' | 'edit' }[] };
}

export interface FilesCapabilities {
  upload: boolean;
  versionHistory: boolean;
  restoreVersions: boolean;
  trash: boolean;
  orgSharing: boolean;
  publicLinks: boolean;
  onlineOnly: boolean;
  keepOnComputer?: boolean;
  authenticatedRemote?: boolean;
  verifiedRecovery?: boolean;
  nativeFilesystem: boolean;
  nativeReveal?: boolean;
  durableOperations?: boolean;
  folderReceipts?: boolean;
  nativeFolderReceipts?: boolean;
  folderCollisionPolicies?: FilesCollisionPolicy[];
  crossCollectionOperations?: FilesCrossCollectionCapability;
}

export interface FilesDataSource {
  openLive?(fileId:string,onEvent:(event:import('./liveTypes').FilesLiveEvent)=>void):Promise<import('./liveTypes').FilesLiveConnection>;

  capabilities: FilesCapabilities;
  publicLinksAvailable?():Promise<boolean>;
  syntheticPreview?:boolean;
  nativeSourceReady?:boolean;
  submitOperation?(request:FilesOperationRequest):Promise<FilesOperationReceipt>;
  getOperation?(operationId:string):Promise<FilesOperationReceipt>;
  cancelOperation?(operationId:string):Promise<FilesOperationReceipt>;
  retryOperation?(operationId:string, request?:FilesOperationRetry):Promise<FilesOperationReceipt>;
  undoOperation?(operationId:string):Promise<FilesOperationReceipt>;
  load(): Promise<FilesSnapshot>;
  loadMore?():Promise<FilesItem[]>;
  loadFolder?(path:string):Promise<FilesItem[]>;
  onFolderFilesChanged?(listener:(files:FilesItem[])=>void):()=>void;
  /** Newest active files of the open collection from the server (bounded), optionally only one creator type. */
  recentFiles?(options?:{ limit?:number; createdByType?:'user' | 'agent-run' }):Promise<FilesItem[]>;
  /** Resolve file ids (e.g. stars) to rows wherever they live, without loading their folders. */
  filesByIds?(ids:string[]):Promise<FilesItem[]>;
  /** Every direct child file of `path`, paged to completion, independent of the open folder listing. */
  listFolderChildren?(path:string):Promise<FilesItem[]>;
  /** Every active file at or below `path`, paged to completion (used when folder receipts are unavailable). */
  listFolderTree?(path:string):Promise<FilesItem[]>;
  /** Server totals for each direct child folder of `path`. */
  folderSummaries?(path:string):Promise<FilesFolderSummary[]>;
  openPreferences?():void;
  selectCollection?(collectionId:string):void;
  operationCapabilities?(collectionId:string):Promise<FilesOperationCapabilities>;
  folderOperationState?(collectionId:string, path:string):Promise<FilesFolderSourceSnapshot>;
  history(fileId:string, currentVersionId:string): Promise<FilesVersion[]>;
  preview(fileId:string, versionId?:string): Promise<FilesPreview>;
  saveContent(request:FilesSaveRequest):Promise<FilesSaveSuccess>;
  detail(fileId:string):Promise<FilesDetail>;
  mediaUrl(fileId:string, versionId?:string):Promise<string>;
  openHtmlPreview?(collectionId:string,fileId:string):Promise<{token:string;url:string}>;
  revokeHtmlPreview?(token:string):Promise<void>;
  search(query:string): Promise<{ files:FilesItem[]; coverage:FilesIndexCoverage }>;
  reindex(fileId:string):Promise<void>;
  setPaused(paused:boolean): Promise<FilesSnapshot['status']>;
  chooseUpload(destination?:string): Promise<number>;
  chooseNativeSource?():Promise<boolean>;
  listNativeSources?():Promise<{ fileId:string; name:string; state:string; lastError?:string; recovery:Record<string, unknown> }[]>;
  recoverNativeSource?(fileId:string):Promise<boolean>;
  uploadPaths(paths:string[], destination?:string): Promise<number>;
  uploadDroppedFiles?(files:File[], destination?:string): Promise<number>;
  createFolder(path:string): Promise<void>;
  updateFolderDescription?(folderId:string, description:string, namingHint?:string):Promise<void>;
  setCollectionCloudSync?(collectionId:string, enabled:boolean):Promise<void>;
  setCloudBackup?(collectionId:string, enabled:boolean):Promise<void>;
  listCloudCollections?():Promise<{ collectionId:string; bytes:number; updatedAt:string }[]>;
  restoreCloudCollection?(collectionId:string, name:string):Promise<void>;
  /** Restores every Cloud collection this Desktop doesn't have, under its original folder name. */
  restoreAllCloudCollections?():Promise<{ restored:string[]; failed:Array<{ collectionId:string; error:string }> }>;
  createFile?(path:string): Promise<void>;
  deleteFolder?(path:string): Promise<void>;
  onCapabilitiesChanged?(listener:() => void):() => void;
  onFilesChanged?(listener:(change:{ collectionId:string; seq:string; paths:string[] }) => void):() => void;
  onUploadProgress?(listener:(progress:{ current:number; total:number; name:string; percent:number; done:boolean }) => void):() => void;
  openFolder(): Promise<void>;
  openFile(fileId:string, versionId?:string): Promise<void>;
  openFileWithDefaultApp?(fileId:string, versionId?:string): Promise<void>;
  openFileWithApp?(fileId:string, versionId?:string, application?:string): Promise<{ application?:string; recentApplications:string[] }>;
  recentAppsForFile?(name:string):Promise<string[]>;
  /** Reveals an authorized tracked original when available, otherwise a verified downloaded copy. */
  revealFile?(fileId:string, versionId?:string): Promise<FilesRevealResult>;
  downloadFile(fileId:string, name:string, versionId?:string):Promise<boolean>;
  downloadFiles(items:{ fileId:string; name:string; versionId?:string }[]):Promise<{ count:number; error?:string }>;
  listStars(collectionId:string):Promise<{ fileId?:string; folderPath?:string }[]>;
  setStar(collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean):Promise<void>;
  operate(action:'move' | 'copy', collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]):Promise<void>;
  restoreVersion(fileId:string, versionId:string): Promise<void>;
  keepConflictCopies?(file:FilesItem): Promise<void>;
  updateLifecycle?(fileId:string, settings:FilesVersioningSettings): Promise<void>;
  checkout?(fileId:string, force?:boolean): Promise<void>;
  checkin?(fileId:string, versionId:string, kind:'major' | 'minor', comment:string, publish:boolean): Promise<void>;
  publishVersion?(fileId:string, versionId:string, expectedDraftVersionId?:string | null, comment?:string): Promise<void>;
  updateRetention?(fileId:string, policy:FilesRetentionPolicy): Promise<void>;
  recordLock?(fileId:string, status:'ordinary' | 'policy'): Promise<void>;
  unlockRecord?(fileId:string): Promise<void>;
  disposalReview?(fileId:string, decision:'approve' | 'reject' | 'extend', extendedUntil?:string): Promise<void>;
  /** Legacy completion-only route. Receipt-aware UI must use restoreTrashItem. */
  restoreTrash?(fileId:string): Promise<void>;
  restoreTrashItem?(item:FilesTrashItem): Promise<FilesTrashRestoreResult>;
  /** Legacy no-CAS route. Receipt-aware UI must use purgeTrashItem. */
  purgeTrash?(fileId:string): Promise<void>;
  purgeTrashItem?(item:FilesTrashItem): Promise<FilesTrashPurgeResult>;
  trashFile(fileId:string): Promise<void>;
  createPublicLink?(fileId:string, options:ShareLinkOptions):Promise<ShareLink>;
  updatePublicLink?(id:string, options:Partial<ShareLinkOptions>):Promise<ShareLink>;
  listPublicLinks?():Promise<ShareLink[]>;
  revokePublicLink?(id:string):Promise<void>;
  restorePublicLink?(id:string, password?:string):Promise<ShareLink>;
  shareActivity?(id?:string):Promise<ShareActivity[]>;
  listFolderShares?(collectionId:string):Promise<FolderShare[]>;
  shareFolder?(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FolderShare>;
  unshareFolder?(share:FolderShare):Promise<void>;
  listFileShares?(fileId:string):Promise<FileAccessList>;
  shareFile?(fileId:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FileShare>;
  updateFileShare?(fileId:string, shareId:string, role:'view' | 'edit'):Promise<FileShare>;
  unshareFile?(fileId:string, shareId:string):Promise<void>;
  listMembers?(orgId:string):Promise<{ members:{ id:string; email:string; role:string }[]; groups?:{ id:string; name?:string; encrypted_name?:string; members?:string[] }[] }>;
  keepOnMac?(fileId:string):Promise<void>;
  makeOnlineOnly?(fileId:string):Promise<void>;
  residencyStatus?(fileId:string):Promise<{ desiredState:'local' | 'online-only'; state:string; lastError:string | null }>;
  onlineOnlyReason?:string;
}
