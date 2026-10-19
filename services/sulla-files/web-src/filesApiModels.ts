import type { FileAccessList, FileShare, FilesItem, FolderShare, SharePrincipalType } from '../../../pkg/rancher-desktop/pages/files/types';

export type FilesApiRecord = Record<string, any>;

export interface FilesApiCollection extends FilesApiRecord {
  id:                    string;
  name:                  string;
  kind:                  string;
  access_role?:          string;
  owner_user_id?:        string;
  shared_folders?:       FilesApiRecord[];
  shared_files?:         FilesApiRecord[];
}

export interface FilesApiFile extends FilesApiRecord {
  id:                 string;
  path:               string;
  current_version_id: string;
}

export function filesItem(file:FilesApiFile):FilesItem {
  return {
    id:               file.id,
    path:             file.path,
    mime:             file.mime ?? 'application/octet-stream',
    size:             Number(file.size ?? 0),
    updatedAt:        file.updated_at ?? new Date(0).toISOString(),
    deletedAt:        file.deleted_at,
    currentVersionId: file.current_version_id,
    versionCount:     Number(file.version_count ?? 1),
    createdByType:    file.created_by_type ?? file.version_created_by_type ?? 'user',
    createdById:      file.created_by_id ?? file.version_created_by_id ?? '',
    ownerDisplayName: file.owner_display_name,
    ownerAvatarUrl:   file.owner_avatar_url,
    syncState:        file.sync_state,
    conflictDevices:  file.conflict_devices === undefined ? undefined : Number(file.conflict_devices),
    indexStatus:      file.extraction_status ?? 'pending',
    indexReasonCode:  file.extraction_reason_code,
    indexReason:      file.extraction_reason ?? 'Waiting for local indexing.',
    indexedAt:        file.extracted_at,
    draftVersionId: file.draft_version_id ?? file.draftVersionId ?? null,
    publishedVersionId: file.published_version_id ?? file.publishedVersionId ?? null,
    publicationState: file.publication_state ?? file.publicationState,
    versioning: file.versioning ? {
      enabled: file.versioning.enabled ?? file.versioning.versioningEnabled ?? false,
      majorMinor: file.versioning.majorMinor ?? false,
      requireApproval: file.versioning.requireApproval ?? false,
      requireCheckout: file.versioning.requireCheckout ?? false,
    } : undefined,
    checkout: file.checkout ?? null,
    retention: file.retention ? { ...file.retention, reason: file.retention.reason ?? file.retention.lockReason ?? null } : undefined,
    record: file.record,
    disposal: file.disposal,
  };
}

export function filesVersion(row:FilesApiRecord, currentVersionId?:string):FilesVersion {
  return {
    ...row,
    id: row.id,
    size: Number(row.size ?? 0),
    deleted: Boolean(row.deleted),
    created_by_type: row.created_by_type ?? row.createdByType ?? 'user',
    created_by_id: row.created_by_id ?? row.createdById ?? '',
    created_at: row.created_at ?? row.createdAt ?? new Date(0).toISOString(),
    message: row.comment ?? row.message,
    versionNumber: row.version_number ?? row.versionNumber,
    versionKind: row.version_kind ?? row.versionKind,
    publicationStatus: row.publication_status ?? row.publicationStatus,
    current: row.id === currentVersionId,
  };
}

export function folderShare(row:FilesApiRecord, collectionId:string, fallback?:Partial<FolderShare>):FolderShare {
  return {
    id:            row.id,
    collectionId:  row.collection_id ?? row.collectionId ?? collectionId,
    folderPath:    row.folder_path ?? row.folderPath ?? fallback?.folderPath ?? '',
    principalType: row.principal_type ?? row.principalType ?? fallback?.principalType,
    principalId:   row.principal_id ?? row.principalId ?? fallback?.principalId,
    principalName: row.principal_name ?? row.principalName,
    role:           row.role ?? fallback?.role,
  } as FolderShare;
}

export function fileShare(row:FilesApiRecord, fileId:string, fallback?:{ principalType:SharePrincipalType; principalId:string; role:'view' | 'edit' }):FileShare {
  return {
    id:            row.id,
    fileId:        row.file_id ?? row.fileId ?? fileId,
    principalType: row.principal_type ?? row.principalType ?? fallback?.principalType,
    principalId:   row.principal_id ?? row.principalId ?? fallback?.principalId,
    principalName: row.principal_name ?? row.principalName,
    role:           row.role ?? fallback?.role,
  } as FileShare;
}

export function fileAccessList(access:FilesApiRecord, fileId:string, collectionId:string):FileAccessList {
  return {
    ownerId: access.ownerId ?? access.owner_id,
    direct: (access.direct ?? []).map((row:FilesApiRecord) => fileShare(row, fileId)),
    inherited: (access.inherited ?? []).map((row:FilesApiRecord) => ({
      id:            row.id,
      collectionId:  row.collection_id ?? row.collectionId ?? collectionId,
      source:        row.source,
      folderPath:    row.folder_path ?? row.folderPath,
      principalType: row.principal_type ?? row.principalType,
      principalId:   row.principal_id ?? row.principalId,
      principalName: row.principal_name ?? row.principalName,
      role:           row.role,
    })),
  };
}
