import { fileAccessList, fileShare, filesItem, folderShare, type FilesApiCollection, type FilesApiFile } from '../../../../services/sulla-files/web-src/filesApiModels';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { FileAccessList, FilesDataSource, FilesDetail, FileShare, FilesItem, FilesPreview, FilesSnapshot, FilesVersion, FolderShare, ShareActivity, ShareLink, ShareLinkOptions, SharePrincipalType } from './types';
import type { IpcRendererEvent } from 'electron';

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
  };

  onlineOnlyReason = '';

  private files: FilesItem[] = [];
  private currentVersions = new Map<string, string>();
  private collectionId = '';

  async load():Promise<FilesSnapshot> {
    const [collections, status, capabilities] = await Promise.all([
      ipcRenderer.invoke('sulla-files:collections') as Promise<FilesApiCollection[]>,
      ipcRenderer.invoke('files-ui:status'),
      (ipcRenderer.invoke('files-ui:capabilities') as Promise<{ orgSharing:boolean; publicLinks:boolean; onlineOnly:boolean; keepOnComputer:boolean; authenticatedRemote:boolean; verifiedRecovery:boolean; onlineOnlyReason?:string }>).catch(() => ({
        orgSharing:         false,
        publicLinks:        false,
        onlineOnly:         false,
        keepOnComputer:     false,
        authenticatedRemote:false,
        verifiedRecovery:   false,
        onlineOnlyReason:   'Cloud and remote Files capabilities are unavailable.',
      })),
    ]);
    const collection = collections.find(item => item.name === 'Files') ?? collections.find(item => item.kind === 'knowledge');
    if (!collection) throw new Error('No Files collection is available yet. Open ~/sulla/files to initialize it.');
    this.collectionId = collection.id;
    Object.assign(this.capabilities, capabilities, {
      orgSharing: capabilities.orgSharing && ['manage', 'owner'].includes(collection.access_role ?? ''),
    });
    this.onlineOnlyReason = capabilities.onlineOnlyReason ?? '';
    const [active, trash] = await Promise.all([
      ipcRenderer.invoke('sulla-files:list', { collectionId: collection.id }) as Promise<FilesApiFile[]>,
      ipcRenderer.invoke('sulla-files:trash-list', { collectionId: collection.id }) as Promise<FilesApiFile[]>,
    ]);

    this.files = [...active, ...trash].map(file => {
      const item = filesItem(file);
      this.currentVersions.set(item.id, item.currentVersionId);
      return item;
    });
    if (this.files.some(file => /\(conflicted copy [^)]+\)/i.test(file.path))) status.state = 'conflict';

    return {
      collection: {
        id:              collection.id,
        name:            collection.name,
        home:            collection.home,
        orgId:           collection.org_id,
        retentionPolicy: collection.retention_policy ?? { trashDays: 90 },
        storageQuota:    collection.storage_quota === undefined ? undefined : Number(collection.storage_quota),
        keptBytes:       collection.kept_bytes === undefined ? undefined : Number(collection.kept_bytes),
        desktopCount:    collection.desktop_count === undefined ? undefined : Number(collection.desktop_count),
        memberCount:     collection.member_count === undefined ? undefined : Number(collection.member_count),
        accountName:     collection.account_display_name,
        accountRole:     collection.access_role,
        ownerUserId:     collection.owner_user_id,
        sharedFolders:   collection.shared_folders?.map(folder => folder.folderPath),
      },
      files: this.files,
      status,
    };
  }

  async history(fileId:string):Promise<FilesVersion[]> {
    const versions = await ipcRenderer.invoke('sulla-files:history', { fileId }) as Omit<FilesVersion, 'current'>[];

    return versions.map(version => ({ ...version, current: version.id === this.currentVersions.get(fileId) }));
  }

  async preview(fileId:string, versionId?:string):Promise<FilesPreview> {
    const result = await ipcRenderer.invoke('sulla-files:preview', { fileId, versionId }) as { mime: string; data: Uint8Array };

    return { ...result, data: new Uint8Array(result.data), path: this.files.find(file => file.id === fileId)?.path ?? '' };
  }

  detail(fileId:string):Promise<FilesDetail> { return ipcRenderer.invoke('sulla-files:metadata', { fileId }) }
  mediaUrl(fileId:string, versionId?:string):Promise<string> { return ipcRenderer.invoke('files-ui:media-url', { fileId, versionId }) }

  async search(query:string):Promise<FilesItem[]> {
    const results = await ipcRenderer.invoke('sulla-files:search', { query, collectionId: this.collectionId }) as { id:string }[];
    const byId = new Map(this.files.map(file => [file.id, file]));
    return results.map(result => byId.get(result.id)).filter((file):file is FilesItem => Boolean(file && !file.deletedAt));
  }

  setPaused(paused:boolean):Promise<FilesSnapshot['status']> { return ipcRenderer.invoke('files-ui:set-paused', paused) }
  chooseUpload(destination = ''):Promise<number> { return ipcRenderer.invoke('files-ui:pick-upload', destination) }
  uploadPaths(paths:string[], destination = ''):Promise<number> { return ipcRenderer.invoke('files-ui:upload-paths', { paths, destination }) }
  createFolder(path:string):Promise<void> { return ipcRenderer.invoke('files-ui:create-folder', path) }
  onUploadProgress(listener:(progress:{ current: number; total: number; name: string; percent: number; done: boolean }) => void):() => void {
    const wrapped = (_event:IpcRendererEvent, progress:{ current: number; total: number; name: string; percent: number; done: boolean }) => listener(progress);

    ipcRenderer.on('files-ui:upload-progress', wrapped);
    return () => ipcRenderer.removeListener('files-ui:upload-progress', wrapped);
  }

  openFolder():Promise<void> { return ipcRenderer.invoke('files-ui:open-folder') }
  openFile(fileId:string, versionId?:string):Promise<void> { return ipcRenderer.invoke('files-ui:open-file', { fileId, versionId }) }
  downloadFile(fileId:string, name:string, versionId?:string):Promise<boolean> { return ipcRenderer.invoke('files-ui:download-file', { fileId, versionId, name }) }
  downloadFiles(items:{ fileId:string; name:string; versionId?:string }[]):Promise<{ count:number; error?:string }> { return ipcRenderer.invoke('files-ui:download-files', items) }
  listStars(collectionId:string):Promise<{ fileId?:string; folderPath?:string }[]> { return ipcRenderer.invoke('sulla-files:stars', { collectionId }) }
  setStar(collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean):Promise<void> { return ipcRenderer.invoke('sulla-files:set-star', { collectionId, ...target, starred }) }
  operate(action:'move' | 'copy', collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]):Promise<void> { return ipcRenderer.invoke('sulla-files:operate', { action, collectionId, items }) }
  restoreVersion(fileId:string, versionId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:restore-version', { fileId, versionId }) }
  restoreTrash(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:trash-restore', { fileId }) }
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
