// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

export interface FilesSaveRequest { fileId:string; baseVersionId:string; content:string }
export interface FilesSaveSuccess { status:'saved' | 'merged'; fileId:string; path:string; mime:string; content:string; versionId:string }
export interface FilesSaveConflict { code:'VERSION_CONFLICT'; error:string; currentVersionId:string }
