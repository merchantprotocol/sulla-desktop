// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { filesItem, filesVersion, type FilesApiCollection, type FilesApiFile, type FilesApiRecord } from '../../../../services/sulla-files/web-src/filesApiModels';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import { DesktopFilesIpcCommands } from './DesktopFilesIpcCommands';
import { DesktopFilesRecordMapper } from './DesktopFilesRecordMapper';
import { normalizeFilesIndexCoverage, type FilesDataSource, type FilesFolderState, type FilesFolderSummary, type FilesIndexCoverage, type FilesItem, type FilesPreview, type FilesSnapshot, type FilesVersion } from './types';

import type { IpcRendererEvent } from 'electron';
import type { SullaFilesNativeRuntimeStatus } from '@pkg/utils/sullaFilesNativeSource';

interface CollectionStats { fileCount:number; totalBytes:number; agentRunCount:number; indexing:FilesIndexCoverage }

interface RemoteCapabilities {
  orgSharing: boolean;
  publicLinks: boolean;
  onlineOnly: boolean;
  keepOnComputer: boolean;
  authenticatedRemote: boolean;
  verifiedRecovery: boolean;
  onlineOnlyReason?: string;
}

/** The Files data source for Sulla Desktop: the open collection, its paged listing and caches, over IPC. */
export class DesktopFilesDataSource extends DesktopFilesIpcCommands implements FilesDataSource {
  openPreferences():void { this.ipc.send('preferences-open', 'files') }
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
    nativeReveal:    true,
    durableOperations:false,
    folderReceipts:  false,
    nativeFolderReceipts:false,
    folderCollisionPolicies:[] as ('replace' | 'keep-both' | 'skip')[],
    crossCollectionOperations:'unavailable' as 'unavailable' | 'all-authorized' | 'stored-authorized',
  };

  onlineOnlyReason = '';

  private filesCursor:string|null = null;
  private filesHasMore = false;
  private listingPath = '';
  private loadingMore = false;
  private loadingMorePromise:Promise<FilesItem[]>|null = null;
  private listingGeneration = 0;
  private folderListeners = new Set<(files:FilesItem[])=>void>();
  private statsCache:{ collectionId:string; at:number; value:CollectionStats }|null = null;
  static readonly statsMaxAgeMs = 30_000;
  private summaryCache = new Map<string,{ at:number; value:FilesFolderSummary[] }>();
  private watching = false;
  private watchedCollectionId = '';
  private rootId = '';
  private capabilitiesGeneration = 0;
  private remoteCapabilitiesReady?:Promise<void>;
  private capabilitiesListeners = new Set<() => void>();
  private nativeRuntimeGeneration = -1;

  constructor(ipc: typeof ipcRenderer = ipcRenderer, records = new DesktopFilesRecordMapper()) {
    super(ipc, records);
    const changed = (_event:IpcRendererEvent, status:SullaFilesNativeRuntimeStatus) => this.applyNativeRuntime(status);

    this.ipc.on('files-ui:native-runtime-changed', changed);
    (this.ipc.invoke('files-ui:native-runtime') as Promise<SullaFilesNativeRuntimeStatus>)
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

  selectCollection(collectionId:string):void { if(collectionId!==this.collectionId){this.listingGeneration++;this.listingPath='';this.files=[];this.filesCursor=null;this.filesHasMore=false;} this.collectionId = collectionId }

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
    this.remoteCapabilitiesReady = (this.ipc.invoke('files-ui:capabilities') as Promise<RemoteCapabilities>)
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

  async publicLinksAvailable():Promise<boolean> {
    await this.remoteCapabilitiesReady;
    return this.capabilities.publicLinks;
  }

  async load():Promise<FilesSnapshot> {
    const listingGeneration = this.listingGeneration;
    const listingPath = this.listingPath;
    this.capabilities.durableOperations = false;
    this.capabilities.folderReceipts = false;
    this.capabilities.nativeFolderReceipts = false;
    this.capabilities.folderCollisionPolicies = [];
    this.capabilities.crossCollectionOperations = 'unavailable';
    const capabilitiesGeneration = ++this.capabilitiesGeneration;
    this.resetRemoteCapabilities();
    const [collections, status, cloudBackupStatus] = await Promise.all([
      this.ipc.invoke('sulla-files:collections') as Promise<FilesApiCollection[]>,
      this.ipc.invoke('files-ui:status'),
      this.ipc.invoke('files-ui:cloud-backup-status').catch(() => null) as Promise<import('@pkg/main/cloud/filesSyncV1/containerClient').FilesSyncStatus|null>,
    ]);
    const roots = await this.ipc.invoke('files-preferences:list-roots') as { id:string; name:string; collectionId?:string; activation:string; state?:string; pendingFiles?:number; lastError?:string; lastScanAt?:string; lastSyncAt?:string; serverConfigured?:boolean }[];
    const availableCollections = collections.map(collection => ({ id: collection.id,
      name: collection.name || roots.find(root => root.collectionId === collection.id)?.name || collection.explorer_path || '',
      systemArea: (collection as FilesApiCollection & { systemArea?: 'logs' | 'sulla' | null }).systemArea ?? null,
      treePath: collection.explorer_path ?? '',
      workspaceScope: (collection as FilesApiCollection & { workspaceScope?: 'personal' | 'organization' }).workspaceScope,
      orgId: (collection as FilesApiCollection & { orgId?: string }).orgId,
      orgName: (collection as FilesApiCollection & { orgName?: string }).orgName,
      level: (collection as FilesApiCollection & { level?: string }).level }));
    const collection = collections.find(item => item.id === this.collectionId) ??
      collections.find(item => item.id === roots.find(root => root.id === 'default')?.collectionId) ??
      collections.find(item => availableCollections.some(candidate => candidate.id === item.id));
    if (!collection) throw new Error('No Files collection is available yet. Wait for Files to finish starting, then try again.');
    if (this.collectionId !== collection.id) this.listingPath = '';
    this.collectionId = collection.id;
    if (this.watching && this.watchedCollectionId !== collection.id) {
      this.watchedCollectionId = collection.id;
      await this.ipc.invoke('files-ui:watch', collection.id);
    }
    const currentOperationCapabilities = await this.operationCapabilities(collection.id);
    if (capabilitiesGeneration === this.capabilitiesGeneration) Object.assign(this.capabilities, {
      durableOperations:        currentOperationCapabilities.enabled,
      folderReceipts:           currentOperationCapabilities.folderReceipts,
      nativeFolderReceipts:     currentOperationCapabilities.nativeFolderReceipts,
      folderCollisionPolicies:  currentOperationCapabilities.folderCollisionPolicies,
      crossCollectionOperations:currentOperationCapabilities.crossCollectionOperations,
    });
    const selectedRoot = roots.find(root => root.collectionId === collection.id);
    this.capabilities.nativeFilesystem = Boolean(selectedRoot?.activation === 'active');
    this.capabilities.upload = true;
    this.rootId = selectedRoot?.id ?? '';
    if (selectedRoot) {
      status.state = ({ idle: 'synced', scanning: 'syncing', syncing: 'syncing', paused: 'paused', offline: 'error', error: 'error', detached: 'error' } as Record<string, FilesSnapshot['status']['state']>)[selectedRoot.state ?? ''] ?? status.state;
      status.pendingFiles = selectedRoot.pendingFiles ?? status.pendingFiles;
      status.lastError = selectedRoot.lastError;
      status.lastScanAt = selectedRoot.lastScanAt;
      status.lastSyncAt = selectedRoot.lastSyncAt;
      status.serverConfigured = selectedRoot.serverConfigured ?? status.serverConfigured;
    }
    this.refreshCapabilities(collection.access_role ?? '', capabilitiesGeneration, selectedRoot?.id === 'default');
    const [activePage, trash, stats] = await Promise.all([
      this.ipc.invoke('sulla-files:list-page', { collectionId: collection.id, path:listingPath, children:true }) as Promise<{files:FilesApiFile[];nextCursor:string|null;hasMore:boolean}>,
      this.ipc.invoke('sulla-files:trash-list', { collectionId: collection.id }) as Promise<FilesApiFile[]>,
      this.collectionStats(collection.id),
    ]).catch((error) => {
      if (capabilitiesGeneration === this.capabilitiesGeneration) {
        this.capabilitiesGeneration++;
        this.resetRemoteCapabilities();
      }
      throw error;
    });
    if (listingGeneration !== this.listingGeneration || listingPath !== this.listingPath) return this.load();

    // File rows are scoped to the open directory; the complete folder tree remains independently paged.
    const loaded = [...activePage.files];
    const cursor = activePage.nextCursor;
    const hasMore = activePage.hasMore;
    this.files = loaded.map(file => filesItem(file));
    this.filesCursor = cursor;
    this.filesHasMore = hasMore && Boolean(cursor);
    if (this.filesHasMore) void this.completeFolder(listingGeneration,listingPath);
    this.listingPath = this.listingPath || '';
    const trashItems = (trash as FilesApiRecord[]).map(record => this.records.trashItem(record));
    if (this.files.some(file => file.syncState === 'conflict')) status.state = 'conflict';

    const snapshot:FilesSnapshot = {
      folders: await this.ipc.invoke('sulla-files:folders', { collectionId: collection.id, details: true }).catch(() => []) as FilesFolderState[],
      collection: {
        id:              collection.id,
        name:            collection.name,
        home:            collection.home,
        orgId:           collection.org_id,
        retentionPolicy: collection.retention_policy ?? {},
        storageQuota:    collection.storage_quota === undefined ? undefined : Number(collection.storage_quota),
        keptBytes:       collection.kept_bytes === undefined ? undefined : Number(collection.kept_bytes),
        fileCount:       stats?.fileCount,
        totalBytes:      stats?.totalBytes,
        agentRunCount:   stats?.agentRunCount,
        desktopCount:    collection.desktop_count === undefined ? undefined : Number(collection.desktop_count),
        memberCount:     collection.member_count === undefined ? undefined : Number(collection.member_count),
        accountName:     collection.account_display_name,
        accountRole:     collection.access_role,
        ownerUserId:     collection.owner_user_id,
        systemArea:      (collection as FilesApiCollection & { systemArea?: 'logs' | 'sulla' | null }).systemArea ?? null,
        sharedFolders:   collection.shared_folders?.map(folder => folder.folderPath),
        cloudCatalogSync: Boolean((collection as FilesApiCollection & { cloud_catalog_sync?: boolean }).cloud_catalog_sync),
        cloudBackup: (() => { const backup=cloudBackupStatus?.collections.find(item=>item.collectionId===collection.id); return backup ? { ...backup, cryptoModule:cloudBackupStatus!.cryptoModule } : undefined })(),
      },
      availableCollections,
      files: this.files,
      trash: trashItems,
      status: { ...status, indexing: stats ? normalizeFilesIndexCoverage(stats.indexing) : this.records.indexCoverage(this.files.filter(file => !file.deletedAt)) },
    };
    return snapshot;
  }

  async loadFolder(path:string):Promise<FilesItem[]> {
    const generation=++this.listingGeneration;
    this.listingPath=path; this.files=[]; this.filesCursor=null; this.filesHasMore=false;
    const page=await this.ipc.invoke('sulla-files:list-page',{collectionId:this.collectionId,path,children:true}) as {files:FilesApiFile[];nextCursor:string|null;hasMore:boolean};
    if(generation!==this.listingGeneration || path!==this.listingPath) return this.files;
    this.files=page.files.map(file=>filesItem(file)); this.filesCursor=page.nextCursor; this.filesHasMore=page.hasMore;
    void this.completeFolder(generation,path);
    return this.files;
  }

  /** Collection-wide totals from the server; cached briefly and dropped on any change event for the collection. */
  private async collectionStats(collectionId:string):Promise<CollectionStats|undefined> {
    const cached=this.statsCache;
    if(cached && cached.collectionId===collectionId && Date.now()-cached.at<DesktopFilesDataSource.statsMaxAgeMs) return cached.value;
    try {
      const value=await this.ipc.invoke('sulla-files:stats',{collectionId}) as CollectionStats;
      this.statsCache={collectionId,at:Date.now(),value};
      return value;
    } catch { return undefined }
  }

  async recentFiles(options:{ limit?:number; createdByType?:'user' | 'agent-run' } = {}):Promise<FilesItem[]> {
    if(!this.collectionId) return [];
    const rows=await this.ipc.invoke('sulla-files:recent',{collectionId:this.collectionId,limit:options.limit ?? 50,...(options.createdByType?{createdByType:options.createdByType}:{})}) as FilesApiFile[];
    return rows.map(row=>filesItem(row)).filter(file=>!file.deletedAt);
  }

  async filesByIds(ids:string[]):Promise<FilesItem[]> {
    const known=new Map(this.files.map(file=>[file.id,file]));
    const found:FilesItem[]=[];
    const pending=[...new Set(ids)];
    // Bounded fan-out: stars and search hits are resolved a few at a time, never by loading folders.
    for(let index=0;index<pending.length;index+=8) {
      const batch=await Promise.all(pending.slice(index,index+8).map(async id=>known.get(id) ?? await (this.ipc.invoke('sulla-files:metadata',{fileId:id}) as Promise<FilesApiFile>).then(record=>filesItem(record)).catch(()=>null)));
      for(const file of batch) if(file && !file.deletedAt) found.push(file);
    }
    return found;
  }

  /**
   * Resolves one document for the editor. `load()` only lists the collection root, so a nested file is
   * found by id through metadata first; only when that misses is its parent folder loaded (scoping the
   * data source to the file's folder) and searched by path, following every page.
   */
  async resolveFile(ref:{ fileId?:string; path?:string }, known:FilesItem[] = []):Promise<FilesItem|null> {
    const live = (file:FilesItem|undefined):FilesItem|null => file && !file.deletedAt ? file : null;
    const inKnown = live(known.find(file => ref.fileId !== undefined && file.id === ref.fileId)) ?? live(known.find(file => ref.path !== undefined && file.path === ref.path));
    if (inKnown) return inKnown;
    if (ref.fileId) {
      const [byId] = await this.filesByIds([ref.fileId]);
      if (byId) return byId;
    }
    if (!ref.path) return null;
    const slash = ref.path.lastIndexOf('/');
    const parent = slash < 0 ? '' : ref.path.slice(0, slash);
    const samePath = (file:FilesItem) => file.path === ref.path && !file.deletedAt;
    const firstPage = (await this.loadFolder(parent)).find(samePath);
    return firstPage ?? (await this.listFolderChildren(parent)).find(samePath) ?? null;
  }

  listFolderChildren(path:string):Promise<FilesItem[]> { return this.pageAll({ path, children:true }) }

  listFolderTree(path:string):Promise<FilesItem[]> { return this.pageAll({ path, children:false }) }

  async folderSummaries(path:string):Promise<FilesFolderSummary[]> {
    if(!this.collectionId) return [];
    // Root summaries scan the whole collection, so the 12-second refresh reuses them until a change event arrives.
    const key=`${ this.collectionId }\n${ path }`; const cached=this.summaryCache.get(key);
    if(cached && Date.now()-cached.at<DesktopFilesDataSource.statsMaxAgeMs) return cached.value;
    const value=await this.ipc.invoke('sulla-files:folder-summary',{collectionId:this.collectionId,path}) as FilesFolderSummary[];
    this.summaryCache.set(key,{at:Date.now(),value});
    return value;
  }

  private async pageAll(input:{ path:string; children:boolean }):Promise<FilesItem[]> {
    const collectionId=this.collectionId; const files:FilesItem[]=[]; let cursor:string|undefined;
    for(;;) {
      const page=await this.ipc.invoke('sulla-files:list-page',{collectionId,path:input.path,children:input.children,...(cursor?{cursor}:{})}) as {files:FilesApiFile[];nextCursor:string|null;hasMore:boolean};
      files.push(...page.files.map(file=>filesItem(file)));
      if(!page.hasMore || !page.nextCursor || page.nextCursor===cursor) return files;
      cursor=page.nextCursor;
    }
  }

  private async completeFolder(generation:number,path:string):Promise<void> {
    while(generation===this.listingGeneration && path===this.listingPath && this.filesHasMore) {
      await this.loadMore(generation);
    }
  }

  async loadMore(generation=this.listingGeneration):Promise<FilesItem[]> {
    if(this.loadingMore) {
      await this.loadingMorePromise;
      return generation===this.listingGeneration ? this.loadMore(generation) : this.files;
    }
    if(!this.filesHasMore || !this.collectionId) return this.files;
    const path=this.listingPath;
    this.loadingMore=true;
    this.loadingMorePromise=(async()=>{ try {
      const cursor=this.filesCursor;
      const page=await this.ipc.invoke('sulla-files:list-page',{collectionId:this.collectionId,path,children:true,cursor}) as {files:FilesApiFile[];nextCursor:string|null;hasMore:boolean};
      if(generation!==this.listingGeneration || path!==this.listingPath) return this.files;
      this.files.push(...page.files.map(file=>filesItem(file)));
      this.filesCursor=page.nextCursor; this.filesHasMore=page.hasMore;
      this.folderListeners.forEach(listener=>listener([...this.files]));
      return this.files;
    } finally { this.loadingMore=false; this.loadingMorePromise=null; } })();
    return this.loadingMorePromise;
  }

  async history(fileId:string, currentVersionId:string):Promise<FilesVersion[]> {
    const versions = await this.ipc.invoke('sulla-files:history', { fileId }) as FilesApiRecord[];

    return versions.map(version => filesVersion(version, currentVersionId));
  }

  async preview(fileId:string, versionId?:string):Promise<FilesPreview> {
    const result = await this.ipc.invoke('sulla-files:preview', { fileId, versionId }) as { mime: string; data: Uint8Array };

    return { ...result, data: new Uint8Array(result.data), path: this.files.find(file => file.id === fileId)?.path ?? '' };
  }

  async search(query:string):Promise<{ files:FilesItem[]; coverage:FilesIndexCoverage }> {
    const response = await this.ipc.invoke('sulla-files:search', { query, collectionId: this.collectionId }) as { results:{ id:string }[]; coverage:FilesIndexCoverage };
    const byId = new Map(this.files.map(file => [file.id, file]));
    const details = await Promise.all(response.results.map(async result => byId.get(result.id) ?? await this.ipc.invoke('sulla-files:metadata',{fileId:result.id}).then(record=>filesItem(record as FilesApiFile)).catch(()=>null)));
    return { files: details.filter((file):file is FilesItem=>Boolean(file&&!file.deletedAt)), coverage: normalizeFilesIndexCoverage(response.coverage) };
  }

  reindex(fileId:string):Promise<void> { return this.ipc.invoke('sulla-files:reindex', { fileId }) }

  async setPaused(paused:boolean):Promise<FilesSnapshot['status']> {
    if (!this.rootId) throw new Error('This Files collection is not backed by a tracked folder.');
    await this.ipc.invoke('files-preferences:update-root', { id: this.rootId, paused });
    return (await this.load()).status;
  }

  chooseUpload(destination = ''):Promise<number> { return this.ipc.invoke('files-ui:pick-upload', { collectionId: this.collectionId, destination }) }
  createFolder(path:string):Promise<void> { return this.ipc.invoke('files-ui:create-folder', { collectionId: this.collectionId, path }) }
  onCapabilitiesChanged(listener:() => void):() => void {
    this.capabilitiesListeners.add(listener);
    return () => this.capabilitiesListeners.delete(listener);
  }

  onFolderFilesChanged(listener:(files:FilesItem[])=>void):()=>void { this.folderListeners.add(listener); return ()=>this.folderListeners.delete(listener) }

  onFilesChanged(listener:(change:{ collectionId:string; seq:string; paths:string[] }) => void):() => void {
    const wrapped = (_event:IpcRendererEvent, change:{ collectionId:string; seq:string; paths:string[] }) => { if (this.statsCache?.collectionId === change.collectionId) this.statsCache = null; this.summaryCache.clear(); listener(change) };
    this.watching = true;
    this.ipc.on('files-ui:changed', wrapped);
    if (this.collectionId) {
      this.watchedCollectionId = this.collectionId;
      void this.ipc.invoke('files-ui:watch', this.collectionId);
    }
    return () => {
      this.watching = false;
      this.watchedCollectionId = '';
      this.ipc.removeListener('files-ui:changed', wrapped);
      void this.ipc.invoke('files-ui:watch', '');
    };
  }

  openFolder():Promise<void> { return this.ipc.invoke('files-ui:open-folder', this.collectionId) }
  restoreVersion(fileId:string, versionId:string):Promise<void> { return this.ipc.invoke('sulla-files:restore-version', { fileId, versionId }) }
}
