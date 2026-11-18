// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { fileAccessList, fileShare, filesDetail, folderShare, type FilesApiRecord } from '../../../../services/sulla-files/web-src/filesApiModels';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import { DesktopFilesRecordMapper, type DesktopOperationCapabilities } from './DesktopFilesRecordMapper';

import type { FileAccessList, FilesDetail, FileShare, FilesFolderSourceSnapshot, FilesItem, FilesOperationCapabilities, FilesOperationReceipt, FilesOperationRequest, FilesOperationRetry, FilesRetentionPolicy, FilesRevealResult, FilesSaveConflict, FilesSaveRequest, FilesSaveSuccess, FilesTrashItem, FilesTrashPurgeResult, FilesTrashRestoreResult, FilesVersioningSettings, FolderShare, ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType } from './types';
import { webUtils, type IpcRendererEvent } from 'electron';

/**
 * The stateless Files IPC commands behind DesktopFilesDataSource: each method forwards one request
 * to the main process with the open collection. Listing, caching and capability state stay in
 * DesktopFilesDataSource, which extends this class so its public method names are unchanged.
 */
export abstract class DesktopFilesIpcCommands {
  protected collectionId = '';
  protected files: FilesItem[] = [];

  constructor(protected readonly ipc: typeof ipcRenderer = ipcRenderer, protected readonly records = new DesktopFilesRecordMapper()) {}

  async openLive(fileId:string,onEvent:(event:import('./liveTypes').FilesLiveEvent)=>void):Promise<import('./liveTypes').FilesLiveConnection> {
    const joined=await this.ipc.invoke('sulla-files:live-join',{fileId});if('error' in joined)throw new Error(joined.error);
    const channel=`sulla-files:live:${joined.peerId}` as const;
    const listener=(_event:IpcRendererEvent,event:import('./liveTypes').FilesLiveEvent)=>onEvent(event);
    this.ipc.on(channel,listener);
    const close=async()=>{this.ipc.removeListener(channel,listener);await this.ipc.invoke('sulla-files:live-leave',{peerId:joined.peerId});};
    const started=await this.ipc.invoke('sulla-files:live-start',{peerId:joined.peerId});if(started.error){await close();throw new Error(started.error);}
    return {join:joined,close,sync:async(message:string)=>{const result=await this.ipc.invoke('sulla-files:live-sync',{peerId:joined.peerId,message});if(result.error)throw new Error(result.error);return {message:result.message??null};}};
  }

  async saveContent(request:FilesSaveRequest):Promise<FilesSaveSuccess> {
    const result = await this.ipc.invoke('sulla-files:save-content', request) as FilesSaveSuccess | { conflict:FilesSaveConflict };

    if ('conflict' in result) throw Object.assign(new Error(result.conflict.error), { status: 409, ...result.conflict });

    return result;
  }

  async detail(fileId:string):Promise<FilesDetail> {
    const result = await this.ipc.invoke('sulla-files:metadata', { fileId }) as FilesApiRecord;

    return filesDetail(result);
  }
  mediaUrl(fileId:string, versionId?:string):Promise<string> { return this.ipc.invoke('files-ui:media-url', { fileId, versionId }) }
  openHtmlPreview(collectionId:string,fileId:string):Promise<{token:string;url:string}> { return this.ipc.invoke('files:preview:open', { collectionId,fileId }) }
  async revokeHtmlPreview(token:string):Promise<void> { await this.ipc.invoke('files:preview:revoke', { token }) }

  async chooseNativeSource():Promise<boolean> { return Boolean(await this.ipc.invoke('files-experiment:pick-native-source')) }
  listNativeSources():Promise<{ fileId:string; name:string; state:string; lastError?:string; recovery:Record<string, unknown> }[]> { return this.ipc.invoke('files-experiment:list-native-sources') }
  async recoverNativeSource(fileId:string):Promise<boolean> { return Boolean(await this.ipc.invoke('files-experiment:recover-native-source', fileId)) }
  uploadPaths(paths:string[], destination = ''):Promise<number> { return this.ipc.invoke('files-ui:upload-paths', { paths, destination, collectionId: this.collectionId }) }
  uploadDroppedFiles(files:File[], destination = ''):Promise<number> {
    const paths = files.map(file => webUtils.getPathForFile(file));
    if (paths.some(value => !value)) throw new Error('Sulla could not read one or more dropped files. Use Choose files instead.');
    return this.uploadPaths(paths, destination);
  }
  updateFolderDescription(folderId:string, description:string, namingHint?:string):Promise<void> { return this.ipc.invoke('files-ui:update-folder-description', { folderId, description, namingHint }) }
  setCollectionCloudSync(collectionId:string, enabled:boolean):Promise<void> { return this.ipc.invoke('files-ui:set-collection-cloud-sync', { collectionId, enabled }) }
  async setCloudBackup(collectionId:string, enabled:boolean):Promise<void> { await this.ipc.invoke('files-ui:set-cloud-backup', { collectionId, enabled }) }
  listCloudCollections():Promise<{ collectionId:string; bytes:number; updatedAt:string }[]> { return this.ipc.invoke('files-ui:cloud-collections') }
  async restoreCloudCollection(collectionId:string, name:string):Promise<void> { await this.ipc.invoke('files-ui:restore-cloud-collection', { collectionId, name }) }
  restoreAllCloudCollections():Promise<{ restored:string[]; failed:Array<{ collectionId:string; error:string }> }> { return this.ipc.invoke('files-ui:restore-all-cloud-collections') }
  createFile(path:string):Promise<void> { return this.ipc.invoke('sulla-files:create-empty-file', { collectionId: this.collectionId, path }) }
  deleteFolder(path:string):Promise<void> { return this.ipc.invoke('files-ui:delete-folder', { collectionId: this.collectionId, path }) }
  keepConflictCopies(file:FilesItem):Promise<void> {
    if (!file.conflictSourceFileId || !file.conflictSourceVersionId) throw new Error('This conflict cannot be acknowledged safely. Refresh Files and try again.');
    return this.ipc.invoke('sulla-files:keep-conflict-copies', { fileId: file.id, currentVersionId: file.currentVersionId, sourceFileId: file.conflictSourceFileId, sourceVersionId: file.conflictSourceVersionId });
  }
  async operationCapabilities(collectionId:string):Promise<FilesOperationCapabilities> {
    const value = await this.ipc.invoke('sulla-files:operation-capabilities', { collectionId }).catch(() => ({ enabled:false, crossCollectionOperations:'unavailable' })) as DesktopOperationCapabilities;

    return this.records.operationCapabilities(value);
  }
  folderOperationState(collectionId:string, path:string):Promise<FilesFolderSourceSnapshot> { return this.ipc.invoke('sulla-files:folder-operation-state', { collectionId, path }) }

  onUploadProgress(listener:(progress:{ current: number; total: number; name: string; percent: number; done: boolean }) => void):() => void {
    const wrapped = (_event:IpcRendererEvent, progress:{ current: number; total: number; name: string; percent: number; done: boolean }) => listener(progress);

    this.ipc.on('files-ui:upload-progress', wrapped);
    return () => this.ipc.removeListener('files-ui:upload-progress', wrapped);
  }

  openFile(fileId:string, versionId?:string):Promise<void> { return this.ipc.invoke('files-ui:open-file', { fileId, versionId }) }
  openFileWithDefaultApp(fileId:string, versionId?:string):Promise<void> { return this.ipc.invoke('files-ui:open-default', { fileId, versionId }) }
  openFileWithApp(fileId:string, versionId?:string, application?:string):Promise<{ application?:string; recentApplications:string[] }> { return this.ipc.invoke('files-ui:open-with', { fileId, versionId, application }) }
  recentAppsForFile(name:string):Promise<string[]> { return this.ipc.invoke('files-ui:recent-apps', { name }) }
  revealFile(fileId:string, versionId?:string):Promise<FilesRevealResult> { return this.ipc.invoke('files-ui:reveal-file', { fileId, versionId }) }
  downloadFile(fileId:string, name:string, versionId?:string):Promise<boolean> { return this.ipc.invoke('files-ui:download-file', { fileId, versionId, name }) }
  downloadFiles(items:{ fileId:string; name:string; versionId?:string }[]):Promise<{ count:number; error?:string }> { return this.ipc.invoke('files-ui:download-files', items) }
  listStars(collectionId:string):Promise<{ fileId?:string; folderPath?:string }[]> { return this.ipc.invoke('sulla-files:stars', { collectionId }) }
  setStar(collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean):Promise<void> { return this.ipc.invoke('sulla-files:set-star', { collectionId, ...target, starred }) }
  operate(action:'move' | 'copy', collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]):Promise<void> { return this.ipc.invoke('sulla-files:operate', { action, collectionId, items }) }
  submitOperation(request:FilesOperationRequest):Promise<FilesOperationReceipt> { return this.ipc.invoke('sulla-files:operation-submit', request) }
  getOperation(operationId:string):Promise<FilesOperationReceipt> { return this.ipc.invoke('sulla-files:operation-status', { operationId }) }
  cancelOperation(operationId:string):Promise<FilesOperationReceipt> { return this.ipc.invoke('sulla-files:operation-cancel', { operationId }) }
  retryOperation(operationId:string, request:FilesOperationRetry = {}):Promise<FilesOperationReceipt> { return this.ipc.invoke('sulla-files:operation-retry', { operationId, request }) }
  undoOperation(operationId:string):Promise<FilesOperationReceipt> { return this.ipc.invoke('sulla-files:operation-undo', { operationId }) }
  updateLifecycle(fileId:string,settings:FilesVersioningSettings):Promise<void> { return this.ipc.invoke('sulla-files:lifecycle', { fileId, settings }) }
  checkout(fileId:string,force=false):Promise<void> { return this.ipc.invoke('sulla-files:checkout', { fileId, force }) }
  checkin(fileId:string,versionId:string,kind:'major'|'minor',comment:string,publish:boolean):Promise<void> { return this.ipc.invoke('sulla-files:checkin', { fileId, versionId, kind, comment, publish }) }
  publishVersion(fileId:string,versionId:string,expectedDraftVersionId?:string|null,comment?:string):Promise<void> { return this.ipc.invoke('sulla-files:publish', { fileId, versionId, expectedDraftVersionId, comment }) }
  updateRetention(fileId:string,policy:FilesRetentionPolicy):Promise<void> { return this.ipc.invoke('sulla-files:retention', { fileId, policy }) }
  recordLock(fileId:string,status:'ordinary'|'policy'):Promise<void> { return this.ipc.invoke('sulla-files:record-lock', { fileId, status }) }
  unlockRecord(fileId:string):Promise<void> { return this.ipc.invoke('sulla-files:record-unlock', { fileId }) }
  disposalReview(fileId:string,decision:'approve'|'reject'|'extend',extendedUntil?:string):Promise<void> { return this.ipc.invoke('sulla-files:disposal-review', { fileId, decision, extendedUntil }) }
  restoreTrashItem(item:FilesTrashItem):Promise<FilesTrashRestoreResult> {
    return this.ipc.invoke('sulla-files:trash-restore', {
      id: item.id, kind: item.kind, expectedRevision: item.revision,
      currentTombstone: { id: item.currentTombstone.id, receiptId: item.currentTombstone.receiptId },
    });
  }
  purgeTrashItem(item:FilesTrashItem):Promise<FilesTrashPurgeResult> {
    if (item.kind === 'folder') return this.ipc.invoke('sulla-files:trash-purge', {
      id: item.id, kind: 'folder', expectedRevision: item.revision,
      currentTombstone: { kind: 'receipt', id: item.currentTombstone.id, receiptId: item.currentTombstone.receiptId },
      invalidateUndo: true,
    });

    return this.ipc.invoke('sulla-files:trash-purge', {
      id: item.id, expectedRevision: item.revision,
      currentTombstone: { id: item.currentTombstone.id },
      ...(item.currentTombstone.receiptId ? { invalidateUndo: true } : {}),
    });
  }
  trashFile(fileId:string):Promise<void> { return this.ipc.invoke('sulla-files:trash', { fileId }) }
  keepOnMac(fileId:string):Promise<void> { return this.ipc.invoke('files-ui:set-residency', { fileId, desiredState: 'local' }) }
  makeOnlineOnly(fileId:string):Promise<void> { return this.ipc.invoke('files-ui:set-residency', { fileId, desiredState: 'online-only' }) }
  residencyStatus(fileId:string):Promise<{ desiredState:'local' | 'online-only'; state:string; lastError:string | null }> { return this.ipc.invoke('files-ui:residency-status', { fileId }) }
  createPublicLink(fileId:string, options:ShareLinkOptions):Promise<ShareLink> {
    return this.ipc.invoke('files-ui:create-link', { fileId, ...options });
  }

  createOrgCollection(input:{ orgId?:string; orgName?:string; name:string }):Promise<{ collectionId:string; path:string }> {
    return this.ipc.invoke('files-ui:create-org-collection', input);
  }

  updatePublicLink(id:string, options:Partial<ShareLinkOptions>):Promise<ShareLink> {
    return this.ipc.invoke('files-ui:update-link', { id, options });
  }

  listPublicLinks():Promise<ShareLink[]> { return this.ipc.invoke('files-ui:list-links') }
  revokePublicLink(id:string):Promise<void> { return this.ipc.invoke('files-ui:revoke-link', id) }
  restorePublicLink(id:string, password?:string):Promise<ShareLink> { return this.ipc.invoke('files-ui:restore-link', { id, password }) }
  shareActivity(id?:string):Promise<ShareActivity[]> { return this.ipc.invoke('files-ui:link-activity', id) }

  async listFolderShares(collectionId:string):Promise<FolderShare[]> {
    const shares = await this.ipc.invoke('sulla-files:shares', { collectionId });
    return shares.map(share => folderShare(share, collectionId));
  }

  async shareFolder(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FolderShare> {
    const share = await this.ipc.invoke('sulla-files:share', { collectionId, folderPath, principalType, principalId, role });
    return folderShare(share, collectionId, { folderPath, principalType, principalId, role });
  }

  unshareFolder(share:FolderShare):Promise<void> {
    return this.ipc.invoke('sulla-files:unshare', share);
  }

  async listFileShares(fileId:string):Promise<FileAccessList> {
    const access = await this.ipc.invoke('sulla-files:file-shares', { fileId });
    return fileAccessList(access, fileId, this.collectionId);
  }

  async shareFile(fileId:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FileShare> {
    const share = await this.ipc.invoke('sulla-files:share-file', { fileId, principalType, principalId, role });
    return fileShare(share, fileId, { principalType, principalId, role });
  }

  async updateFileShare(fileId:string, shareId:string, role:'view' | 'edit'):Promise<FileShare> {
    const share = await this.ipc.invoke('sulla-files:update-file-share', { fileId, shareId, role });
    return fileShare(share, fileId);
  }

  unshareFile(fileId:string, shareId:string):Promise<void> {
    return this.ipc.invoke('sulla-files:unshare-file', { fileId, shareId });
  }

  listMembers(orgId:string):Promise<{ members:{ id:string; email:string; role:string }[]; groups?:{ id:string; name?:string; encrypted_name?:string; members?:string[] }[] }> {
    return this.ipc.invoke('sulla-files:members', { orgId });
  }
}
