export type FilesSyncState = 'synced' | 'syncing' | 'paused' | 'error' | 'conflict';
export type FilesIndexState = 'pending' | 'indexing' | 'indexed' | 'unsupported' | 'failed';
export interface FilesIndexCoverage { total:number; pending:number; indexing:number; indexed:number; partial:number; unsupported:number; failed:number; complete:boolean }

export type FilesPublicationStatus = 'draft' | 'published' | 'superseded';
export type FilesPublicationState = 'draft' | 'published';
export type FilesRetentionMode = 'none' | 'retain-until' | 'event';

export interface FilesRetentionPolicy {
  mode: FilesRetentionMode;
  retainUntil?: string | null;
  eventType?: string | null;
  eventOccurredAt?: string | null;
  durationDays?: number | null;
  reason?: string | null;
  active?: boolean;
}

export interface FilesItemCapabilities {
  canEdit: boolean;
  canManage: boolean;
  canViewDraft: boolean;
  canPublish: boolean;
}

export interface FilesVersioningSettings {
  enabled: boolean;
  majorMinor: boolean;
  requireApproval: boolean;
  requireCheckout: boolean;
}

export interface FilesCheckout {
  userId: string;
  deviceId?: string;
  at: string;
}

export interface FilesRecordStatus {
  status: 'none' | 'ordinary' | 'policy';
  lockedAt?: string | null;
  lockedBy?: string | null;
}

export interface FilesDisposalStatus {
  status: 'none' | 'pending' | 'approved' | 'rejected';
  reviewAt?: string | null;
  extendedUntil?: string | null;
}

export function normalizeFilesIndexCoverage(coverage:Omit<FilesIndexCoverage, 'partial'> & { partial?:number }):FilesIndexCoverage {
  const knowsPartial = Number.isFinite(coverage.partial);
  const partial = knowsPartial ? Number(coverage.partial) : 0;

  return { ...coverage, partial, complete: coverage.complete && knowsPartial && partial === 0 };
}

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
  indexStatus: FilesIndexState;
  indexReasonCode?: string;
  indexReason: string;
  indexedAt?: string;
  draftVersionId?: string | null;
  publishedVersionId?: string | null;
  publicationState?: FilesPublicationState;
  versioning?: FilesVersioningSettings;
  checkout?: FilesCheckout | null;
  retention?: FilesRetentionPolicy;
  record?: FilesRecordStatus;
  disposal?: FilesDisposalStatus;
  capabilities?: FilesItemCapabilities;
}

export function filesItemHasActiveProtection(item:Pick<FilesItem, 'retention' | 'record' | 'disposal'>, now = Date.now()):boolean {
  if (item.retention?.active !== undefined) return item.retention.active;
  if (item.record?.status === 'ordinary' || item.record?.status === 'policy') return true;
  const extension = Date.parse(item.disposal?.extendedUntil ?? '');

  if (Number.isFinite(extension) && extension > now) return true;
  if (item.retention?.mode === 'retain-until') {
    const retainUntil = Date.parse(item.retention.retainUntil ?? '');

    return Number.isFinite(retainUntil) && retainUntil > now;
  }
  if (item.retention?.mode === 'event') {
    const durationDays = item.retention.durationDays;

    if (!item.retention.eventOccurredAt || typeof durationDays !== 'number' || !Number.isSafeInteger(durationDays) || durationDays < 0) return true;
    const occurredAt = Date.parse(item.retention.eventOccurredAt);

    return !Number.isFinite(occurredAt) || occurredAt + durationDays * 86_400_000 > now;
  }

  return false;
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
  versionNumber?: string;
  versionKind?: 'major' | 'minor';
  publicationStatus?: FilesPublicationStatus;
}

export interface FilesSnapshot {
  collection: { id: string; name: string; home: string; orgId?: string; retentionPolicy: Record<string, unknown>; storageQuota?: number; keptBytes?: number; desktopCount?: number; memberCount?: number; accountName?: string; accountRole?: string; ownerUserId?: string; sharedFolders?: string[] };
  availableCollections?: { id:string; name:string }[];
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
    indexing: FilesIndexCoverage;
  };
}

export interface FilesPreview {
  data: Uint8Array;
  mime: string;
  path: string;
}

export type FilesRevealResult =
  | { status:'revealed'; target:'materialized-copy'; fileId:string; versionId:string }
  | { status:'unavailable'; code:'no-local-copy' | 'local-copy-changed'; reason:string };

export interface RecordingSegment { start:number; end:number; text:string }
export interface RecordingChapter { start:number; end:number; title:string }
export interface FilesDetail {
  item?: FilesItem;
  capabilities?: FilesItemCapabilities;
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
  keepOnComputer?: boolean;
  authenticatedRemote?: boolean;
  verifiedRecovery?: boolean;
  nativeFilesystem: boolean;
  nativeReveal?: boolean;
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

export interface FileShare {
  id: string;
  fileId: string;
  principalType: SharePrincipalType;
  principalId: string;
  principalName?: string;
  role: 'view' | 'edit';
}

export interface InheritedFileShare {
  id: string;
  collectionId: string;
  source: 'collection' | 'folder';
  folderPath?: string;
  principalType: SharePrincipalType;
  principalId: string;
  principalName?: string;
  role: 'view' | 'use-by-agents' | 'edit' | 'manage';
}

export interface FileAccessList {
  ownerId?: string;
  direct: FileShare[];
  inherited: InheritedFileShare[];
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
  selectCollection?(collectionId:string):void;
  history(fileId:string, currentVersionId:string): Promise<FilesVersion[]>;
  preview(fileId:string, versionId?:string): Promise<FilesPreview>;
  detail(fileId:string):Promise<FilesDetail>;
  mediaUrl(fileId:string, versionId?:string):Promise<string>;
  search(query:string): Promise<{ files:FilesItem[]; coverage:FilesIndexCoverage }>;
  reindex(fileId:string):Promise<void>;
  setPaused(paused:boolean): Promise<FilesSnapshot['status']>;
  chooseUpload(destination?:string): Promise<number>;
  uploadPaths(paths:string[], destination?:string): Promise<number>;
  createFolder(path:string): Promise<void>;
  onCapabilitiesChanged?(listener:() => void):() => void;
  onUploadProgress?(listener:(progress:{ current:number; total:number; name:string; percent:number; done:boolean }) => void):() => void;
  openFolder(): Promise<void>;
  openFile(fileId:string, versionId?:string): Promise<void>;
  /** Reveals an authorized local copy, never promises an original host file. */
  revealFile?(fileId:string, versionId?:string): Promise<FilesRevealResult>;
  downloadFile(fileId:string, name:string, versionId?:string):Promise<boolean>;
  downloadFiles(items:{ fileId:string; name:string; versionId?:string }[]):Promise<{ count:number; error?:string }>;
  listStars(collectionId:string):Promise<{ fileId?:string; folderPath?:string }[]>;
  setStar(collectionId:string, target:{ fileId?:string; folderPath?:string }, starred:boolean):Promise<void>;
  operate(action:'move' | 'copy', collectionId:string, items:{ fileId?:string; folderPath?:string; targetPath:string }[]):Promise<void>;
  restoreVersion(fileId:string, versionId:string): Promise<void>;
  updateLifecycle?(fileId:string, settings:FilesVersioningSettings): Promise<void>;
  checkout?(fileId:string, force?:boolean): Promise<void>;
  checkin?(fileId:string, versionId:string, kind:'major' | 'minor', comment:string, publish:boolean): Promise<void>;
  publishVersion?(fileId:string, versionId:string, expectedDraftVersionId?:string | null, comment?:string): Promise<void>;
  updateRetention?(fileId:string, policy:FilesRetentionPolicy): Promise<void>;
  recordLock?(fileId:string, status:'ordinary' | 'policy'): Promise<void>;
  unlockRecord?(fileId:string): Promise<void>;
  disposalReview?(fileId:string, decision:'approve' | 'reject' | 'extend', extendedUntil?:string): Promise<void>;
  restoreTrash(fileId:string): Promise<void>;
  purgeTrash?(fileId:string): Promise<void>;
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
  listFileShares?(fileId:string):Promise<FileAccessList>;
  shareFile?(fileId:string, principalType:SharePrincipalType, principalId:string, role:'view' | 'edit'):Promise<FileShare>;
  updateFileShare?(fileId:string, shareId:string, role:'view' | 'edit'):Promise<FileShare>;
  unshareFile?(fileId:string, shareId:string):Promise<void>;
  listMembers?(orgId:string):Promise<{ members:{ id:string; email:string; role:string }[]; groups?:{ id:string; name?:string; encrypted_name?:string; members?:string[] }[] }>;
  keepOnMac?(fileId:string):Promise<void>;
  makeOnlineOnly?(fileId:string):Promise<void>;
  residencyStatus?(fileId:string):Promise<{ desiredState:'local' | 'online-only'; state:string; lastError:string | null }>;
  onlineOnlyReason?:string;
}
