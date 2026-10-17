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

export type ShareAccessMode = 'view' | 'download';
export type ShareAssetKind = 'file' | 'capture' | 'artifact';
export type SharePrincipalType = 'user' | 'group';

export interface SharePrincipal {
  id: string;
  type: SharePrincipalType;
  name: string;
  detail?: string;
  role?: string;
}

export interface FolderShare {
  id?: string;
  collectionId: string;
  folderPath: string;
  principalType: SharePrincipalType;
  principalId: string;
  principalName?: string;
  role: 'view' | 'edit';
}

export interface ShareLinkOptions {
  mode: ShareAccessMode;
  password?: string;
  expiresAt?: string | null;
  displaySharerName: boolean;
  keepAvailable: boolean;
  keepUntil?: string | null;
  assetKind?: ShareAssetKind;
  captureMetadata?: Record<string, unknown>;
}

export interface ShareLink {
  id: string;
  url: string;
  name: string;
  mode: ShareAccessMode;
  password: boolean;
  expiresAt?: string;
  viewCount: number;
  lastViewedAt?: string;
  keepAvailable: boolean;
  keepUntil?: string;
  displaySharerName: boolean;
  servedFrom: 'desktop' | 'server' | 'cloud';
  assetKind: ShareAssetKind;
  source?: string;
  targetId?: string;
  revokedAt?: string;
  createdAt?: string;
}

export interface ShareActivity {
  id: string;
  action: 'created' | 'viewed' | 'downloaded' | 'updated' | 'revoked';
  occurredAt: string;
  detail?: string;
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
  createPublicLink?(fileId:string, options:ShareLinkOptions):Promise<ShareLink>;
  updatePublicLink?(id:string, options:Partial<ShareLinkOptions>):Promise<ShareLink>;
  listPublicLinks?():Promise<ShareLink[]>;
  revokePublicLink?(id:string):Promise<void>;
  restorePublicLink?(id:string, password?:string):Promise<ShareLink>;
  shareActivity?(id?:string):Promise<ShareActivity[]>;
  listFolderShares?(collectionId:string):Promise<FolderShare[]>;
  shareFolder?(collectionId:string, folderPath:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FolderShare>;
  unshareFolder?(share:FolderShare):Promise<void>;
  listMembers?(orgId:string):Promise<{ members:{ id:string; email:string; role:string }[]; groups?:{ id:string; name?:string; encrypted_name?:string; members?:string[] }[] }>;
  keepOnMac?(fileId:string):Promise<void>;
  onlineOnlyReason?:string;
}
