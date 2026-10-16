import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { FilesDataSource, FilesItem, FilesPreview, FilesSnapshot, FilesVersion } from './types';

interface ContainerCollection {
  id:string;
  name:string;
  kind:string;
  home:string;
  retention_policy?:Record<string, unknown>;
}

interface ContainerFile {
  id:string;
  path:string;
  mime:string;
  size:number | string;
  updated_at?:string;
  deleted_at?:string;
  current_version_id:string;
  version_count?:number | string;
  created_by_type?:string;
  created_by_id?:string;
  version_created_by_type?:string;
  version_created_by_id?:string;
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
  } as const;

  private files:FilesItem[] = [];
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
    };

    this.currentVersions.set(item.id, item.currentVersionId);
    return item;
  }

  async load():Promise<FilesSnapshot> {
    const [collections, status] = await Promise.all([
      ipcRenderer.invoke('sulla-files:collections') as Promise<ContainerCollection[]>,
      ipcRenderer.invoke('files-ui:status'),
    ]);
    const collection = collections.find(item => item.name === 'Files') ?? collections.find(item => item.kind === 'knowledge');
    if (!collection) throw new Error('No Files collection is available yet. Open ~/sulla/Files to initialize it.');
    const [active, trash] = await Promise.all([
      ipcRenderer.invoke('sulla-files:list', { collectionId: collection.id }) as Promise<ContainerFile[]>,
      ipcRenderer.invoke('sulla-files:trash-list', { collectionId: collection.id }) as Promise<ContainerFile[]>,
    ]);

    this.files = [...active, ...trash].map(file => this.toItem(file));
    if (this.files.some(file => /\(conflicted copy [^)]+\)/i.test(file.path))) status.state = 'conflict';

    return {
      collection: { id: collection.id, name: collection.name, home: collection.home, retentionPolicy: collection.retention_policy ?? { trashDays: 90 } },
      files: this.files,
      status,
    };
  }

  async history(fileId:string):Promise<FilesVersion[]> {
    const versions = await ipcRenderer.invoke('sulla-files:history', { fileId }) as Omit<FilesVersion, 'current'>[];

    return versions.map(version => ({ ...version, current: version.id === this.currentVersions.get(fileId) }));
  }

  async preview(fileId:string, versionId?:string):Promise<FilesPreview> {
    const result = await ipcRenderer.invoke('sulla-files:preview', { fileId, versionId }) as { mime:string; data:Uint8Array };

    return { ...result, data: new Uint8Array(result.data), path: this.files.find(file => file.id === fileId)?.path ?? '' };
  }

  search(query:string):Promise<FilesItem[]> {
    const normalized = query.toLocaleLowerCase();

    return Promise.resolve(this.files.filter(file => !file.deletedAt && file.path.toLocaleLowerCase().includes(normalized)));
  }

  setPaused(paused:boolean):Promise<FilesSnapshot['status']> { return ipcRenderer.invoke('files-ui:set-paused', paused) }
  chooseUpload():Promise<number> { return ipcRenderer.invoke('files-ui:pick-upload') }
  uploadPaths(paths:string[]):Promise<number> { return ipcRenderer.invoke('files-ui:upload-paths', paths) }
  openFolder():Promise<void> { return ipcRenderer.invoke('files-ui:open-folder') }
  openFile(path:string):Promise<void> { return ipcRenderer.invoke('files-ui:open-file', path) }
  restoreVersion(fileId:string, versionId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:restore-version', { fileId, versionId }) }
  restoreTrash(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:trash-restore', { fileId }) }
  trashFile(fileId:string):Promise<void> { return ipcRenderer.invoke('sulla-files:trash', { fileId }) }
}
