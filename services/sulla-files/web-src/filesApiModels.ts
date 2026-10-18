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
