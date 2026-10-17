import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { FilesDataSource, FilesItem, FilesPreview, FilesSnapshot, FilesVersion } from './types';
import type { IpcRendererEvent } from 'electron';

interface ContainerCollection {
  id:                    string;
  name:                  string;
  kind:                  string;
  home:                  string;
  retention_policy?:     Record<string, unknown>;
  storage_quota?:        number | string;
  kept_bytes?:           number | string;
  desktop_count?:        number | string;
  member_count?:         number | string;
  account_display_name?: string;
  access_role?:          string;
  owner_user_id?:        string;
  org_id?:               string;
  shared_folders?:       { folderPath: string; role: string }[];
}

interface ContainerFile {
  id:                       string;
  path:                     string;
  mime:                     string;
  size:                     number | string;
  updated_at?:              string;
  deleted_at?:              string;
  current_version_id:       string;
  version_count?:           number | string;
  created_by_type?:         string;
  created_by_id?:           string;
  version_created_by_type?: string;
  version_created_by_id?:   string;
  owner_display_name?:      string;
  owner_avatar_url?:        string;
  sync_state?:              FilesItem['syncState'];
  conflict_devices?:        number | string;
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
  };

  onlineOnlyReason = '';

  private files: FilesItem[] = [];
  private currentVersions = new Map<string, string>();

  private toItem(file:ContainerFile):FilesItem {
    const item = {
      id:               file.id,
      path:             file.path,
      mime:             file.mime || 'application/octet-stream',
      size:             Number(file.size ?? 0),
      updatedAt:        file.updated_at ?? new Date(0).toISOString(),
      deletedAt:        file.deleted_at ?? undefined,
      currentVersionId: file.current_version_id,
      versionCount:     Number(file.version_count ?? 1),
      createdByType:    file.created_by_type ?? file.version_created_by_type ?? 'user',
      createdById:      file.created_by_id ?? file.version_created_by_id ?? '',
      ownerDisplayName: file.owner_display_name,
      ownerAvatarUrl:   file.owner_avatar_url,
      syncState:        file.sync_state,
      conflictDevices:  file.conflict_devices === undefined ? undefined : Number(file.conflict_devices),
    };

    this.currentVersions.set(item.id, item.currentVersionId);
    return item;
  }

  async load():Promise<FilesSnapshot> {
    const [collections, status, capabilities] = await Promise.all([
      ipcRenderer.invoke('sulla-files:collections') as Promise<ContainerCollection[]>,
      ipcRenderer.invoke('files-ui:status'),
      ipcRenderer.invoke('files-ui:capabilities') as Promise<{ orgSharing:boolean; publicLinks:boolean; onlineOnly:boolean; onlineOnlyReason?:string }>,
    ]);
    const collection = collections.find(item => item.name === 'Files') ?? collections.find(item => item.kind === 'knowledge');
    if (!collection) throw new Error('No Files collection is available yet. Open ~/sulla/files to initialize it.');
    Object.assign(this.capabilities, capabilities, {
      orgSharing: capabilities.orgSharing && ['manage', 'owner'].includes(collection.access_role ?? ''),
    });
    this.onlineOnlyReason = capabilities.onlineOnlyReason ?? '';
    const [active, trash] = await Promise.all([
      ipcRenderer.invoke('sulla-files:list', { collectionId: collection.id }) as Promise<ContainerFile[]>,
      ipcRenderer.invoke('sulla-files:trash-list', { collectionId: collection.id }) as Promise<ContainerFile[]>,
    ]);

    this.files = [...active, ...trash].map(file => this.toItem(file));
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

  search(query:string):Promise<FilesItem[]> {
    const normalized = query.toLocaleLowerCase();

    return Promise.resolve(this.files.filter(file => !file.deletedAt && file.path.toLocaleLowerCase().includes(normalized)));
  }

  setPaused(paused:boolean):Promise<FilesSnapshot['status']> { return ipcRenderer.invoke('files-ui:set-paused', paused) }
  chooseUpload():Promise<number> { return ipcRenderer.invoke('files-ui:pick-upload') }
  uploadPaths(paths:string[]):Promise<number> { return ipcRenderer.invoke('files-ui:upload-paths', paths) }
  createFolder(path:string):Promise<void> { return ipcRenderer.invoke('files-ui:create-folder', path) }
  onUploadProgress(listener:(progress:{ current: number; total: number; name: string; percent: number; done: boolean }) => void):() => void {
    const wrapped = (_event:IpcRendererEvent, progress:{ current: number; total: number; name: string; percent: number; done: boolean }) => listener(progress);

    ipcRenderer.on('files-ui:upload-progress', wrapped);
    return () => ipcRenderer.removeListener('files-ui:upload-progress', wrapped);
  }

  openFolder():Promise<void> { return ipcRenderer.invoke('files-ui:open-folder') }
  openFile(fileId:string, versionId?:string):Promise<void> { return ipcRenderer.invoke('files-ui:open-file', { fileId, versionId }) }
  restoreVersion(fileId:string, versionId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:restore-version', { fileId, versionId }) }
  restoreTrash(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:trash-restore', { fileId }) }
  trashFile(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:trash', { fileId }) }
  createPublicLink(fileId:string, options:{ mode?:'view' | 'download'; keepAvailable?:boolean } = {}):Promise<{ url:string }> {
    return ipcRenderer.invoke('files-ui:create-link', { fileId, mode: options.mode ?? 'view', keepAvailable: options.keepAvailable ?? false });
  }

  shareFolder(collectionId:string, folderPath:string, principalId:string, role:'view' | 'edit'):Promise<void> {
    return ipcRenderer.invoke('sulla-files:share', { collectionId, folderPath, principalType: 'user', principalId, role });
  }

  listMembers(orgId:string):Promise<{ members:{ id:string; email:string; role:string }[] }> {
    return ipcRenderer.invoke('sulla-files:members', { orgId });
  }
}
