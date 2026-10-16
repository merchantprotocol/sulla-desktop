export type FilesSyncState = 'synced' | 'syncing' | 'paused' | 'error' | 'conflict';

export interface FilesLocation {
  kind: 'local' | 'server' | 'cloud';
  label: string;
}

export interface FilesItem {
  id: string;
  path: string;
  mime: string;
  size: number;
  updatedAt: string;
  deletedAt?: string;
  currentVersionId: string;
  versionCount: number;
  createdByType: string;
  createdById: string;
}

export interface FilesVersion {
  id: string;
  parent_version_id?: string;
  size: number;
  deleted: boolean;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  message?: string;
  device_id?: string;
  current: boolean;
}

export interface FilesSnapshot {
  collection: { id: string; name: string; home: string; retentionPolicy: Record<string, unknown> };
  files: FilesItem[];
  status: {
    state: FilesSyncState;
    pendingFiles: number;
    lastError?: string;
    lastScanAt?: string;
    lastSyncAt?: string;
    serverConfigured: boolean;
    location?: 'local' | 'server' | 'cloud';
    serverLabel?: string;
  };
}

export interface FilesPreview {
  data: Uint8Array;
  mime: string;
  path: string;
}

export interface FilesCapabilities {
  upload: boolean;
  versionHistory: boolean;
  restoreVersions: boolean;
  trash: boolean;
  orgSharing: boolean;
  publicLinks: boolean;
  onlineOnly: boolean;
}

export interface FilesDataSource {
  capabilities: FilesCapabilities;
  load(): Promise<FilesSnapshot>;
  history(fileId:string): Promise<FilesVersion[]>;
  preview(fileId:string, versionId?:string): Promise<FilesPreview>;
  search(query:string): Promise<FilesItem[]>;
  setPaused(paused:boolean): Promise<FilesSnapshot['status']>;
  chooseUpload(): Promise<number>;
  uploadPaths(paths:string[]): Promise<number>;
  openFolder(): Promise<void>;
  openFile(path:string): Promise<void>;
  restoreVersion(fileId:string, versionId:string): Promise<void>;
  restoreTrash(fileId:string): Promise<void>;
  trashFile(fileId:string): Promise<void>;
}
