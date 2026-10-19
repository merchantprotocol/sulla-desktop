import { normalizeFilesIndexCoverage, type FileAccessList, type FilesDataSource, type FilesDetail, type FileShare, type FilesIndexCoverage, type FilesItem, type FilesPreview, type FilesRetentionPolicy, type FilesSnapshot, type FilesVersion, type FilesVersioningSettings, type FolderShare, type ShareActivity, type ShareLink, type ShareLinkOptions, type SharePrincipalType } from './types';
import { fileAccessList, fileShare, filesDetail, filesItem, filesVersion, folderShare, type FilesApiCollection, type FilesApiFile, type FilesApiRecord } from '../../../../services/sulla-files/web-src/filesApiModels';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { IpcRendererEvent } from 'electron';
import type { SullaFilesNativeRuntimeStatus } from '@pkg/utils/sullaFilesNativeSource';

interface RemoteCapabilities {
  orgSharing: boolean;
  publicLinks: boolean;
  onlineOnly: boolean;
  keepOnComputer: boolean;
  authenticatedRemote: boolean;
  verifiedRecovery: boolean;
  onlineOnlyReason?: string;
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
  nativeSourceReady = false;
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
  };

  onlineOnlyReason = '';

  private files: FilesItem[] = [];
  private collectionId = '';
  private rootId = '';
  private capabilitiesGeneration = 0;
  private capabilitiesListeners = new Set<() => void>();
  private nativeRuntimeGeneration = -1;

  constructor() {
    const changed = (_event:IpcRendererEvent, status:SullaFilesNativeRuntimeStatus) => this.applyNativeRuntime(status);

    ipcRenderer.on('files-ui:native-runtime-changed', changed);
    (ipcRenderer.invoke('files-ui:native-runtime') as Promise<SullaFilesNativeRuntimeStatus>)
      .then(status => this.applyNativeRuntime(status))
      .catch(() => this.applyNativeRuntime({ state: 'disabled', ready: false, generation: 0, sourceGrant: 'unsupported' }));
  }

  private applyNativeRuntime(status:SullaFilesNativeRuntimeStatus):void {
    if (!status || status.generation < this.nativeRuntimeGeneration) return;
    this.nativeRuntimeGeneration = status.generation;
    const ready = status.state === 'ready' && status.ready;
    if (ready === this.nativeSourceReady) return;
    this.nativeSourceReady = ready;
    this.capabilitiesListeners.forEach(listener => listener());
  }

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
    const capabilitiesGeneration = ++this.capabilitiesGeneration;
    this.resetRemoteCapabilities();
    const [collections, status] = await Promise.all([
      ipcRenderer.invoke('sulla-files:collections') as Promise<FilesApiCollection[]>,
      ipcRenderer.invoke('files-ui:status'),
    ]);
    const roots = await ipcRenderer.invoke('files-preferences:list-roots') as { id:string; name:string; collectionId?:string; activation:string; state?:string; pendingFiles?:number; lastError?:string; lastScanAt?:string; lastSyncAt?:string; serverConfigured?:boolean }[];
    const availableCollections = roots.filter(root => root.activation === 'active' && root.collectionId)
      .map(root => ({ id: root.collectionId!, name: root.name }));
    const collection = collections.find(item => item.id === this.collectionId) ??
      collections.find(item => item.id === roots.find(root => root.id === 'default')?.collectionId) ??
      collections.find(item => availableCollections.some(candidate => candidate.id === item.id));
    if (!collection) throw new Error('No Files collection is available yet. Wait for Files to finish starting, then try again.');
    this.collectionId = collection.id;
    const selectedRoot = roots.find(root => root.collectionId === collection.id);
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
    const [active, trash, folders] = await Promise.all([
      ipcRenderer.invoke('sulla-files:list', { collectionId: collection.id }) as Promise<FilesApiFile[]>,
      ipcRenderer.invoke('sulla-files:trash-list', { collectionId: collection.id }) as Promise<FilesApiFile[]>,
      ipcRenderer.invoke('sulla-files:folders', { collectionId: collection.id }) as Promise<string[]>,
    ]).catch((error) => {
      if (capabilitiesGeneration === this.capabilitiesGeneration) {
        this.capabilitiesGeneration++;
        this.resetRemoteCapabilities();
      }
      throw error;
    });

    this.files = [...active, ...trash].map(file => filesItem(file));
    if (this.files.some(file => file.syncState === 'conflict')) status.state = 'conflict';

    const snapshot:FilesSnapshot = {
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
      folders,
      files: this.files,
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
  async chooseNativeSource():Promise<boolean> { return Boolean(await ipcRenderer.invoke('files-experiment:pick-native-source')) }
  listNativeSources():Promise<{ fileId:string; name:string; state:string; lastError?:string; recovery:Record<string, unknown> }[]> { return ipcRenderer.invoke('files-experiment:list-native-sources') }
  async recoverNativeSource(fileId:string):Promise<boolean> { return Boolean(await ipcRenderer.invoke('files-experiment:recover-native-source', fileId)) }
  uploadPaths(paths:string[], destination = ''):Promise<number> { return ipcRenderer.invoke('files-ui:upload-paths', { paths, destination, collectionId: this.collectionId }) }
  createFolder(path:string):Promise<void> { return ipcRenderer.invoke('files-ui:create-folder', { collectionId: this.collectionId, path }) }
  deleteFolder(path:string):Promise<void> { return ipcRenderer.invoke('files-ui:delete-folder', { collectionId: this.collectionId, path }) }
  keepConflictCopies(file:FilesItem):Promise<void> {
    if (!file.conflictSourceFileId || !file.conflictSourceVersionId) throw new Error('This conflict cannot be acknowledged safely. Refresh Files and try again.');
    return ipcRenderer.invoke('sulla-files:keep-conflict-copies', { fileId: file.id, currentVersionId: file.currentVersionId, sourceFileId: file.conflictSourceFileId, sourceVersionId: file.conflictSourceVersionId });
  }

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
  downloadFile(fileId:string, name:string, versionId?:string):Promise<boolean> { return ipcRenderer.invoke('files-ui:download-file', { fileId, versionId, name }) }
  downloadFiles(items:{ fileId:string; name:string; versionId?:string }[]):Promise<{ count:number; error?:string }> { return ipcRenderer.invoke('files-ui:download-files', items) }
  listStars(collectionId:string):Promise<{ fileId?:string; folderPath?:string }[]> { return ipcRenderer.invoke('sulla-files:stars', { collectionId }) }
  setStar(collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean):Promise<void> { return ipcRenderer.invoke('sulla-files:set-star', { collectionId, ...target, starred }) }
  operate(action:'move' | 'copy', collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]):Promise<void> { return ipcRenderer.invoke('sulla-files:operate', { action, collectionId, items }) }
  restoreVersion(fileId:string, versionId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:restore-version', { fileId, versionId }) }
  updateLifecycle(fileId:string,settings:FilesVersioningSettings):Promise<void> { return ipcRenderer.invoke('sulla-files:lifecycle', { fileId, settings }) }
  checkout(fileId:string,force=false):Promise<void> { return ipcRenderer.invoke('sulla-files:checkout', { fileId, force }) }
  checkin(fileId:string,versionId:string,kind:'major'|'minor',comment:string,publish:boolean):Promise<void> { return ipcRenderer.invoke('sulla-files:checkin', { fileId, versionId, kind, comment, publish }) }
  publishVersion(fileId:string,versionId:string,expectedDraftVersionId?:string|null,comment?:string):Promise<void> { return ipcRenderer.invoke('sulla-files:publish', { fileId, versionId, expectedDraftVersionId, comment }) }
  updateRetention(fileId:string,policy:FilesRetentionPolicy):Promise<void> { return ipcRenderer.invoke('sulla-files:retention', { fileId, policy }) }
  recordLock(fileId:string,status:'ordinary'|'policy'):Promise<void> { return ipcRenderer.invoke('sulla-files:record-lock', { fileId, status }) }
  unlockRecord(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:record-unlock', { fileId }) }
  disposalReview(fileId:string,decision:'approve'|'reject'|'extend',extendedUntil?:string):Promise<void> { return ipcRenderer.invoke('sulla-files:disposal-review', { fileId, decision, extendedUntil }) }
  restoreTrash(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:trash-restore', { fileId }) }
  purgeTrash(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:trash-purge', { fileId }) }
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
