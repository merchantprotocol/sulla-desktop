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

export interface RecordingSegment { start:number; end:number; text:string }
export interface RecordingChapter { start:number; end:number; title:string }
export interface FilesDetail {
  provenance: { type:string; id:string };
  version: FilesVersion;
  recording?: { version_id:string; language?:string; transcript:RecordingSegment[]; chapters:RecordingChapter[]; duration_seconds?:number; generator?:string; generated_at?:string };
  links: { id:string; path:string; mime:string; kind:'links_to' | 'created_by' | 'derived_from'; direction:'incoming' | 'outgoing'; createdAt:string }[];
  activity: { id:string; who_type:string; who_id:string; device_or_run_id?:string; action:string; at:string; details?:Record<string, unknown> }[];
  access: { role?:string; inherited:{ id:string; folder_path:string; principal_type:SharePrincipalType; principal_id:string; role:'view' | 'edit' }[] };
}

export interface FilesCapabilities {
  upload: boolean;
  versionHistory: boolean;
  restoreVersions: boolean;
  trash: boolean;
  orgSharing: boolean;
  publicLinks: boolean;
  onlineOnly: boolean;
  nativeFilesystem: boolean;
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
  targetType?: 'file' | 'capture' | 'artifact';
  collectionId?: string;
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
  syntheticPreview?:boolean;
  load(): Promise<FilesSnapshot>;
  history(fileId:string): Promise<FilesVersion[]>;
  preview(fileId:string, versionId?:string): Promise<FilesPreview>;
  detail(fileId:string):Promise<FilesDetail>;
  mediaUrl(fileId:string, versionId?:string):Promise<string>;
  search(query:string): Promise<FilesItem[]>;
  setPaused(paused:boolean): Promise<FilesSnapshot['status']>;
  chooseUpload(destination?:string): Promise<number>;
  uploadPaths(paths:string[], destination?:string): Promise<number>;
  createFolder(path:string): Promise<void>;
  onUploadProgress?(listener:(progress:{ current:number; total:number; name:string; percent:number; done:boolean }) => void):() => void;
  openFolder(): Promise<void>;
  openFile(fileId:string, versionId?:string): Promise<void>;
  downloadFile(fileId:string, name:string, versionId?:string):Promise<boolean>;
  downloadFiles(items:{ fileId:string; name:string; versionId?:string }[]):Promise<{ count:number; error?:string }>;
  listStars(collectionId:string):Promise<{ fileId?:string; folderPath?:string }[]>;
  setStar(collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean):Promise<void>;
  operate(action:'move' | 'copy', collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]):Promise<void>;
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
