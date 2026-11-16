// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesFolderState, FilesTrashItem } from './filesOperationTypes';

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
  /** Decimal database revision used for receipt-backed mutation CAS. */
  operationRevision?: string;
  versionCount: number;
  createdByType: string;
  createdById: string;
  ownerDisplayName?: string;
  ownerAvatarUrl?: string;
  syncState?: 'synced' | 'syncing' | 'online-only' | 'conflict';
  conflictDevices?: number;
  conflictSourceFileId?: string;
  conflictSourceVersionId?: string;
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
  collection: { id: string; name: string; home: string; systemArea?: 'logs' | 'sulla' | null; orgId?: string; retentionPolicy: Record<string, unknown>; storageQuota?: number; keptBytes?: number; fileCount?: number; totalBytes?: number; agentRunCount?: number; desktopCount?: number; memberCount?: number; accountName?: string; accountRole?: string; ownerUserId?: string; sharedFolders?: string[]; cloudCatalogSync?: boolean; cloudBackup?: { enabled:boolean; status:'off'|'idle'|'syncing'|'error'|'needs-vault'; lastSyncAt?:string|null; pendingBytes:number; conflicts:number; lastError?:string|null; cryptoModule:{provider:string;version:string;fips:boolean} } };
  availableCollections?: { id:string; name:string; treePath?:string; systemArea?: 'logs' | 'sulla' | null }[];
  folders?:(string | FilesFolderState)[];
  files: FilesItem[];
  trash?: FilesTrashItem[];
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
