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
  ownerDisplayName?: string;
  ownerAvatarUrl?: string;
  syncState?: 'synced' | 'syncing' | 'online-only' | 'conflict';
  conflictDevices?: number;
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
  collection: { id: string; name: string; home: string; orgId?: string; retentionPolicy: Record<string, unknown>; storageQuota?: number; keptBytes?: number; desktopCount?: number; memberCount?: number; accountName?: string; accountRole?: string; ownerUserId?: string; sharedFolders?: string[] };
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
    legacyImport?: { state: 'clear' | 'secure-import-required'; protectedPrefix?: string; code?: string; action?: string };
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
  createFolder(path:string): Promise<void>;
  onUploadProgress?(listener:(progress:{ current:number; total:number; name:string; percent:number; done:boolean }) => void):() => void;
  openFolder(): Promise<void>;
  openFile(fileId:string, versionId?:string): Promise<void>;
  restoreVersion(fileId:string, versionId:string): Promise<void>;
  restoreTrash(fileId:string): Promise<void>;
  trashFile(fileId:string): Promise<void>;
  createPublicLink?(fileId:string, options?:{ mode?:'view' | 'download'; keepAvailable?:boolean }):Promise<{ url:string }>;
  shareFolder?(collectionId:string, folderPath:string, principalId:string, role:'view' | 'edit'):Promise<void>;
  listMembers?(orgId:string):Promise<{ members:{ id:string; email:string; role:string }[] }>;
  keepOnMac?(fileId:string):Promise<void>;
  onlineOnlyReason?:string;
}
