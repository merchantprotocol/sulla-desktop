// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Delegating shims for callers outside the E5 S5 slice (app.ts, NativeSourceOperations.ts, NativePathOperationPublisher.ts,
// WatchedFileIngestor.ts, fileOperations.ts,
// cloudSync/repository.ts, CloudFolderCoverageRepository.ts). The logic lives in
// Services/StoredNamespaceGuard.ts and the SQL in Repositories/StoredNamespaceRepository.ts. Each
// call builds its guard from the passed-in client; nothing is held at module level.
import { StoredNamespaceGuard } from './Services/StoredNamespaceGuard.js';
import { StoredNamespaceRepository } from './Repositories/StoredNamespaceRepository.js';

import type { FilesIdentity } from './auth.js';
import type pg from 'pg';

export { StoredNamespaceConflict, StoredNamespaceGuard } from './Services/StoredNamespaceGuard.js';

export function storedParentPaths(path:string):string[] {
  return StoredNamespaceGuard.parentPaths(path);
}

function guard():StoredNamespaceGuard { return new StoredNamespaceGuard(new StoredNamespaceRepository()) }

export function lockStoredNamespace(client:pg.PoolClient, collectionId:string, scopedPath?:string):Promise<void> {
  return guard().lock(client, collectionId, scopedPath);
}

export function lockStoredNamespacePaths(client:pg.PoolClient, collectionId:string, scopedPaths:string[]):Promise<void> {
  return guard().lockPaths(client, collectionId, scopedPaths);
}

export function assertStoredFilePath(client:pg.PoolClient, collectionId:string, path:string, sameFileId?:string):Promise<void> {
  return guard().assertFilePath(client, collectionId, path, sameFileId);
}

export function assertStoredFolderPath(client:pg.PoolClient, collectionId:string, path:string):Promise<void> {
  return guard().assertFolderPath(client, collectionId, path);
}

export function ensureStoredFileParents(client:pg.PoolClient, collectionId:string, filePath:string, actor:FilesIdentity):Promise<void> {
  return guard().ensureFileParents(client, collectionId, filePath, actor);
}

export function ensureStoredFolder(client:pg.PoolClient, collectionId:string, folderPath:string, actor:FilesIdentity):Promise<void> {
  return guard().ensureFolder(client, collectionId, folderPath, actor);
}
