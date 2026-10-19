import { normalizeFilesIndexCoverage, type FileAccessList, type FilesDataSource, type FilesDetail, type FileShare, type FilesFolderState, type FilesIndexCoverage, type FilesItem, type FilesPreview, type FilesRetentionPolicy, type FilesSnapshot, type FilesTrashFile, type FilesTrashFolder, type FilesTrashItem, type FilesTrashPurgeResult, type FilesTrashRestoreResult, type FilesVersion, type FilesVersioningSettings, type FolderShare, type ShareActivity, type ShareLink, type ShareLinkOptions, type SharePrincipalType } from './types';
import { fileAccessList, fileShare, filesDetail, filesItem, filesVersion, folderShare, type FilesApiCollection, type FilesApiFile, type FilesApiRecord } from '../../../../services/sulla-files/web-src/filesApiModels';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { FilesRevealResult, FilesOperationRequest, FilesOperationReceipt, FilesOperationRetry } from './types';
import type { IpcRendererEvent } from 'electron';

interface RemoteCapabilities {
  orgSharing: boolean;
  publicLinks: boolean;
  onlineOnly: boolean;
  keepOnComputer: boolean;
  authenticatedRemote: boolean;
  verifiedRecovery: boolean;
  onlineOnlyReason?: string;
}

interface OperationCapabilities {
  enabled:boolean;
  folderReceipts?:boolean;
  nativeFolderReceipts?:boolean;
  folderCollisionPolicies?:('replace' | 'keep-both' | 'skip')[];
  crossCollectionOperations?:'stored-same-audience-files' | 'unavailable';
}

function trashItem(value:FilesApiRecord):FilesTrashItem {
  if (value.kind === 'folder') {
    return {
      kind:             'folder',
      id:               String(value.id),
      path:             String(value.path),
      revision:         String(value.revision),
      deletedAt:        String(value.deleted_at),
      currentTombstone: value.currentTombstone,
      capabilities:     value.capabilities,
    } as FilesTrashFolder;
  }
  const item = filesItem(value as FilesApiFile);

  return {
    ...item,
    kind:               'file',
    revision:           String(value.revision),
    operationRevision:  String(value.revision),
    currentVersionId:   String(value.currentTombstone?.id),
    currentTombstone:   value.currentTombstone,
  } as FilesTrashFile;
}

function indexCoverage(files:FilesItem[]):FilesIndexCoverage {
  const coverage = { total: files.length, pending: 0, indexing: 0, indexed: 0, partial: 0, unsupported: 0, failed: 0, complete: true };
  for (const file of files) {
    coverage[file.indexStatus]++;
    if (file.indexStatus === 'indexed' && file.indexReasonCode?.endsWith('_partial')) coverage.partial++;
  }
  coverage.complete = coverage.pending === 0 && coverage.indexing === 0 && coverage.partial === 0 && coverage.unsupported === 0 && coverage.failed === 0;
  return coverage;
}

export class DesktopFilesDataSource implements FilesDataSource {
  readonly capabilities = {
    upload:          true,
    versionHistory:  true,
    restoreVersions: true,
    trash:           true,
    orgSharing:      false,
    publicLinks:     false,
    onlineOnly:      false,
    keepOnComputer:  false,
    authenticatedRemote:false,
    verifiedRecovery:false,
    nativeFilesystem:true,
    nativeReveal:    true,
    durableOperations:false,
    folderReceipts:  false,
    nativeFolderReceipts:false,
    folderCollisionPolicies:[] as ('replace' | 'keep-both' | 'skip')[],
    crossCollectionOperations:'unavailable' as 'unavailable' | 'stored-same-audience-files',
  };

  onlineOnlyReason = '';

  private files: FilesItem[] = [];
  private collectionId = '';
  private rootId = '';
  private capabilitiesGeneration = 0;
  private capabilitiesListeners = new Set<() => void>();

  selectCollection(collectionId:string):void { this.collectionId = collectionId }

  private resetRemoteCapabilities():void {
    Object.assign(this.capabilities, {
      orgSharing:         false,
      publicLinks:        false,
      onlineOnly:         false,
      keepOnComputer:     false,
      authenticatedRemote:false,
      verifiedRecovery:   false,
    });
    this.onlineOnlyReason = '';
    this.capabilitiesListeners.forEach(listener => listener());
  }

  private refreshCapabilities(accessRole:string, generation:number, primaryRoot:boolean):void {
    (ipcRenderer.invoke('files-ui:capabilities') as Promise<RemoteCapabilities>)
      .then((capabilities) => {
        if (generation !== this.capabilitiesGeneration) return;
        Object.assign(this.capabilities, capabilities, {
          orgSharing: capabilities.orgSharing && ['manage', 'owner'].includes(accessRole),
          onlineOnly: capabilities.onlineOnly && primaryRoot,
          keepOnComputer: capabilities.keepOnComputer && primaryRoot,
          authenticatedRemote: capabilities.authenticatedRemote && primaryRoot,
          verifiedRecovery: capabilities.verifiedRecovery && primaryRoot,
        });
        this.onlineOnlyReason = capabilities.onlineOnlyReason ?? '';
        this.capabilitiesListeners.forEach(listener => listener());
      })
      .catch(() => {
        if (generation !== this.capabilitiesGeneration) return;
        Object.assign(this.capabilities, {
          orgSharing:         false,
          publicLinks:        false,
          onlineOnly:         false,
          keepOnComputer:     false,
          authenticatedRemote:false,
          verifiedRecovery:   false,
        });
        this.onlineOnlyReason = 'Cloud and remote Files capabilities are unavailable.';
        this.capabilitiesListeners.forEach(listener => listener());
      });
  }

  async load():Promise<FilesSnapshot> {
    this.capabilities.durableOperations = false;
    this.capabilities.folderReceipts = false;
    this.capabilities.nativeFolderReceipts = false;
    this.capabilities.folderCollisionPolicies = [];
    this.capabilities.crossCollectionOperations = 'unavailable';
    const capabilitiesGeneration = ++this.capabilitiesGeneration;
    this.resetRemoteCapabilities();
    const [collections, status] = await Promise.all([
      ipcRenderer.invoke('sulla-files:collections') as Promise<FilesApiCollection[]>,
      ipcRenderer.invoke('files-ui:status'),
    ]);
    const roots = await ipcRenderer.invoke('files-preferences:list-roots') as { id:string; name:string; collectionId?:string; activation:string; state?:string; pendingFiles?:number; lastError?:string; lastScanAt?:string; lastSyncAt?:string; serverConfigured?:boolean }[];
    const availableCollections = collections.map(collection => ({ id: collection.id, name: roots.find(root => root.collectionId === collection.id)?.name ?? collection.name }));
    const collection = collections.find(item => item.id === this.collectionId) ??
      collections.find(item => item.id === roots.find(root => root.id === 'default')?.collectionId) ??
      collections.find(item => availableCollections.some(candidate => candidate.id === item.id));
    if (!collection) throw new Error('No Files collection is available yet. Open ~/sulla/files to initialize it.');
    this.collectionId = collection.id;
    const operationCapabilities = await ipcRenderer.invoke('sulla-files:operation-capabilities', { collectionId: collection.id }).catch(() => ({ enabled: false })) as OperationCapabilities;
    if (capabilitiesGeneration === this.capabilitiesGeneration) Object.assign(this.capabilities, {
      durableOperations:        operationCapabilities.enabled === true,
      folderReceipts:           operationCapabilities.folderReceipts === true,
      nativeFolderReceipts:     operationCapabilities.nativeFolderReceipts === true,
      folderCollisionPolicies:  Array.isArray(operationCapabilities.folderCollisionPolicies) ? operationCapabilities.folderCollisionPolicies.filter((item:unknown) => item === 'replace' || item === 'keep-both' || item === 'skip') : [],
      crossCollectionOperations:operationCapabilities.crossCollectionOperations === 'stored-same-audience-files' ? 'stored-same-audience-files' : 'unavailable',
    });
    const selectedRoot = roots.find(root => root.collectionId === collection.id);
    this.capabilities.nativeFilesystem = Boolean(selectedRoot?.activation === 'active');
    this.capabilities.upload = this.capabilities.nativeFilesystem;
    this.rootId = selectedRoot?.id ?? '';
    if (selectedRoot) {
      status.state = ({ idle: 'synced', scanning: 'syncing', syncing: 'syncing', paused: 'paused', offline: 'error', error: 'error', detached: 'error' } as Record<string, string>)[selectedRoot.state ?? ''] ?? status.state;
      status.pendingFiles = selectedRoot.pendingFiles ?? status.pendingFiles;
      status.lastError = selectedRoot.lastError;
      status.lastScanAt = selectedRoot.lastScanAt;
      status.lastSyncAt = selectedRoot.lastSyncAt;
      status.serverConfigured = selectedRoot.serverConfigured ?? status.serverConfigured;
    }
    this.refreshCapabilities(collection.access_role ?? '', capabilitiesGeneration, selectedRoot?.id === 'default');
    const [active, trash] = await Promise.all([
      ipcRenderer.invoke('sulla-files:list', { collectionId: collection.id }) as Promise<FilesApiFile[]>,
      ipcRenderer.invoke('sulla-files:trash-list', { collectionId: collection.id }) as Promise<FilesApiFile[]>,
    ]).catch((error) => {
      if (capabilitiesGeneration === this.capabilitiesGeneration) {
        this.capabilitiesGeneration++;
        this.resetRemoteCapabilities();
      }
      throw error;
    });

    this.files = active.map(file => filesItem(file));
    const trashItems = (trash as FilesApiRecord[]).map(trashItem);
    if (this.files.some(file => /\(conflicted copy [^)]+\)/i.test(file.path))) status.state = 'conflict';

    const snapshot:FilesSnapshot = {
      folders: await ipcRenderer.invoke('sulla-files:folders', { collectionId: collection.id, details: true }).catch(() => []) as FilesFolderState[],
      collection: {
        id:              collection.id,
        name:            collection.name,
        home:            collection.home,
        orgId:           collection.org_id,
        retentionPolicy: collection.retention_policy ?? {},
        storageQuota:    collection.storage_quota === undefined ? undefined : Number(collection.storage_quota),
        keptBytes:       collection.kept_bytes === undefined ? undefined : Number(collection.kept_bytes),
        desktopCount:    collection.desktop_count === undefined ? undefined : Number(collection.desktop_count),
        memberCount:     collection.member_count === undefined ? undefined : Number(collection.member_count),
        accountName:     collection.account_display_name,
        accountRole:     collection.access_role,
        ownerUserId:     collection.owner_user_id,
        sharedFolders:   collection.shared_folders?.map(folder => folder.folderPath),
      },
      availableCollections,
      files: this.files,
      trash: trashItems,
      status,
    };
    snapshot.status.indexing = indexCoverage(this.files.filter(file => !file.deletedAt));
    return snapshot;
  }

  async history(fileId:string, currentVersionId:string):Promise<FilesVersion[]> {
    const versions = await ipcRenderer.invoke('sulla-files:history', { fileId }) as FilesApiRecord[];

    return versions.map(version => filesVersion(version, currentVersionId));
  }

  async preview(fileId:string, versionId?:string):Promise<FilesPreview> {
    const result = await ipcRenderer.invoke('sulla-files:preview', { fileId, versionId }) as { mime: string; data: Uint8Array };

    return { ...result, data: new Uint8Array(result.data), path: this.files.find(file => file.id === fileId)?.path ?? '' };
  }

  async detail(fileId:string):Promise<FilesDetail> {
    const result = await ipcRenderer.invoke('sulla-files:metadata', { fileId }) as FilesApiRecord;

    return filesDetail(result);
  }
  mediaUrl(fileId:string, versionId?:string):Promise<string> { return ipcRenderer.invoke('files-ui:media-url', { fileId, versionId }) }

  async search(query:string):Promise<{ files:FilesItem[]; coverage:FilesIndexCoverage }> {
    const response = await ipcRenderer.invoke('sulla-files:search', { query, collectionId: this.collectionId }) as { results:{ id:string }[]; coverage:FilesIndexCoverage };
    const byId = new Map(this.files.map(file => [file.id, file]));
    return { files: response.results.map(result => byId.get(result.id)).filter((file):file is FilesItem => Boolean(file && !file.deletedAt)), coverage: normalizeFilesIndexCoverage(response.coverage) };
  }

  reindex(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:reindex', { fileId }) }

  async setPaused(paused:boolean):Promise<FilesSnapshot['status']> {
    if (!this.rootId) throw new Error('This Files collection is not backed by a tracked folder.');
    await ipcRenderer.invoke('files-preferences:update-root', { id: this.rootId, paused });
    return (await this.load()).status;
  }

  chooseUpload(destination = ''):Promise<number> { return ipcRenderer.invoke('files-ui:pick-upload', { collectionId: this.collectionId, destination }) }
  uploadPaths(paths:string[], destination = ''):Promise<number> { return ipcRenderer.invoke('files-ui:upload-paths', { paths, destination, collectionId: this.collectionId }) }
  createFolder(path:string):Promise<void> { return ipcRenderer.invoke('files-ui:create-folder', { collectionId: this.collectionId, path }) }

  onCapabilitiesChanged(listener:() => void):() => void {
    this.capabilitiesListeners.add(listener);
    return () => this.capabilitiesListeners.delete(listener);
  }

  onUploadProgress(listener:(progress:{ current: number; total: number; name: string; percent: number; done: boolean }) => void):() => void {
    const wrapped = (_event:IpcRendererEvent, progress:{ current: number; total: number; name: string; percent: number; done: boolean }) => listener(progress);

    ipcRenderer.on('files-ui:upload-progress', wrapped);
    return () => ipcRenderer.removeListener('files-ui:upload-progress', wrapped);
  }

  openFolder():Promise<void> { return ipcRenderer.invoke('files-ui:open-folder', this.collectionId) }
  openFile(fileId:string, versionId?:string):Promise<void> { return ipcRenderer.invoke('files-ui:open-file', { fileId, versionId }) }
  revealFile(fileId:string, versionId?:string):Promise<FilesRevealResult> { return ipcRenderer.invoke('files-ui:reveal-file', { fileId, versionId }) }
  downloadFile(fileId:string, name:string, versionId?:string):Promise<boolean> { return ipcRenderer.invoke('files-ui:download-file', { fileId, versionId, name }) }
  downloadFiles(items:{ fileId:string; name:string; versionId?:string }[]):Promise<{ count:number; error?:string }> { return ipcRenderer.invoke('files-ui:download-files', items) }
  listStars(collectionId:string):Promise<{ fileId?:string; folderPath?:string }[]> { return ipcRenderer.invoke('sulla-files:stars', { collectionId }) }
  setStar(collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean):Promise<void> { return ipcRenderer.invoke('sulla-files:set-star', { collectionId, ...target, starred }) }
  operate(action:'move' | 'copy', collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]):Promise<void> { return ipcRenderer.invoke('sulla-files:operate', { action, collectionId, items }) }
  submitOperation(request:FilesOperationRequest):Promise<FilesOperationReceipt> { return ipcRenderer.invoke('sulla-files:operation-submit', request) }
  getOperation(operationId:string):Promise<FilesOperationReceipt> { return ipcRenderer.invoke('sulla-files:operation-status', { operationId }) }
  cancelOperation(operationId:string):Promise<FilesOperationReceipt> { return ipcRenderer.invoke('sulla-files:operation-cancel', { operationId }) }
  retryOperation(operationId:string, request:FilesOperationRetry = {}):Promise<FilesOperationReceipt> { return ipcRenderer.invoke('sulla-files:operation-retry', { operationId, request }) }
  undoOperation(operationId:string):Promise<FilesOperationReceipt> { return ipcRenderer.invoke('sulla-files:operation-undo', { operationId }) }
  restoreVersion(fileId:string, versionId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:restore-version', { fileId, versionId }) }
  updateLifecycle(fileId:string,settings:FilesVersioningSettings):Promise<void> { return ipcRenderer.invoke('sulla-files:lifecycle', { fileId, settings }) }
  checkout(fileId:string,force=false):Promise<void> { return ipcRenderer.invoke('sulla-files:checkout', { fileId, force }) }
  checkin(fileId:string,versionId:string,kind:'major'|'minor',comment:string,publish:boolean):Promise<void> { return ipcRenderer.invoke('sulla-files:checkin', { fileId, versionId, kind, comment, publish }) }
  publishVersion(fileId:string,versionId:string,expectedDraftVersionId?:string|null,comment?:string):Promise<void> { return ipcRenderer.invoke('sulla-files:publish', { fileId, versionId, expectedDraftVersionId, comment }) }
  updateRetention(fileId:string,policy:FilesRetentionPolicy):Promise<void> { return ipcRenderer.invoke('sulla-files:retention', { fileId, policy }) }
  recordLock(fileId:string,status:'ordinary'|'policy'):Promise<void> { return ipcRenderer.invoke('sulla-files:record-lock', { fileId, status }) }
  unlockRecord(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:record-unlock', { fileId }) }
  disposalReview(fileId:string,decision:'approve'|'reject'|'extend',extendedUntil?:string):Promise<void> { return ipcRenderer.invoke('sulla-files:disposal-review', { fileId, decision, extendedUntil }) }
  restoreTrashItem(item:FilesTrashItem):Promise<FilesTrashRestoreResult> {
    return ipcRenderer.invoke('sulla-files:trash-restore', {
      id: item.id, kind: item.kind, expectedRevision: item.revision,
      currentTombstone: { id: item.currentTombstone.id, receiptId: item.currentTombstone.receiptId },
    });
  }
  purgeTrashItem(item:FilesTrashItem):Promise<FilesTrashPurgeResult> {
    if (item.kind === 'folder') return ipcRenderer.invoke('sulla-files:trash-purge', {
      id: item.id, kind: 'folder', expectedRevision: item.revision,
      currentTombstone: { kind: 'receipt', id: item.currentTombstone.id, receiptId: item.currentTombstone.receiptId },
      invalidateUndo: true,
    });

    return ipcRenderer.invoke('sulla-files:trash-purge', {
      id: item.id, expectedRevision: item.revision,
      currentTombstone: { id: item.currentTombstone.id },
      ...(item.currentTombstone.receiptId ? { invalidateUndo: true } : {}),
    });
  }
  trashFile(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:trash', { fileId }) }
  keepOnMac(fileId:string):Promise<void> { return ipcRenderer.invoke('files-ui:set-residency', { fileId, desiredState: 'local' }) }
  makeOnlineOnly(fileId:string):Promise<void> { return ipcRenderer.invoke('files-ui:set-residency', { fileId, desiredState: 'online-only' }) }
  residencyStatus(fileId:string):Promise<{ desiredState:'local' | 'online-only'; state:string; lastError:string | null }> { return ipcRenderer.invoke('files-ui:residency-status', { fileId }) }
  createPublicLink(fileId:string, options:ShareLinkOptions):Promise<ShareLink> {
    return ipcRenderer.invoke('files-ui:create-link', { fileId, ...options });
  }

  updatePublicLink(id:string, options:Partial<ShareLinkOptions>):Promise<ShareLink> {
    return ipcRenderer.invoke('files-ui:update-link', { id, options });
  }

  listPublicLinks():Promise<ShareLink[]> { return ipcRenderer.invoke('files-ui:list-links') }
  revokePublicLink(id:string):Promise<void> { return ipcRenderer.invoke('files-ui:revoke-link', id) }
  restorePublicLink(id:string, password?:string):Promise<ShareLink> { return ipcRenderer.invoke('files-ui:restore-link', { id, password }) }
  shareActivity(id?:string):Promise<ShareActivity[]> { return ipcRenderer.invoke('files-ui:link-activity', id) }

  async listFolderShares(collectionId:string):Promise<FolderShare[]> {
    const shares = await ipcRenderer.invoke('sulla-files:shares', { collectionId });
    return shares.map(share => folderShare(share, collectionId));
  }

  async shareFolder(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FolderShare> {
    const share = await ipcRenderer.invoke('sulla-files:share', { collectionId, folderPath, principalType, principalId, role });
    return folderShare(share, collectionId, { folderPath, principalType, principalId, role });
  }

  unshareFolder(share:FolderShare):Promise<void> {
    return ipcRenderer.invoke('sulla-files:unshare', share);
  }

  async listFileShares(fileId:string):Promise<FileAccessList> {
    const access = await ipcRenderer.invoke('sulla-files:file-shares', { fileId });
    return fileAccessList(access, fileId, this.collectionId);
  }

  async shareFile(fileId:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FileShare> {
    const share = await ipcRenderer.invoke('sulla-files:share-file', { fileId, principalType, principalId, role });
    return fileShare(share, fileId, { principalType, principalId, role });
  }

  async updateFileShare(fileId:string, shareId:string, role:'view' | 'edit'):Promise<FileShare> {
    const share = await ipcRenderer.invoke('sulla-files:update-file-share', { fileId, shareId, role });
    return fileShare(share, fileId);
  }

  unshareFile(fileId:string, shareId:string):Promise<void> {
    return ipcRenderer.invoke('sulla-files:unshare-file', { fileId, shareId });
  }

  listMembers(orgId:string):Promise<{ members:{ id:string; email:string; role:string }[]; groups?:{ id:string; name?:string; encrypted_name?:string; members?:string[] }[] }> {
    return ipcRenderer.invoke('sulla-files:members', { orgId });
  }
}
