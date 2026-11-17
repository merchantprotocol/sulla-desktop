// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Cloud-sync row shapes. The SQL lives in src/Repositories/Cloud*Repository.ts and is
// composed by CloudSyncRepositories; this module only keeps the shared types.

import type { NamespaceOperation } from './namespace.js';
import type { Envelope } from '../crypto.js';
import type { SyncHead } from './envelope.js';

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'error' | 'needs-vault' | 'needs-org-key';
export type CloudOp = 'create' | 'escrow' | 'upload-open' | 'commit' | 'delete' | 'info';

export interface UploadSession {
  journalSeq:number;
  fileId:string;
  versionId:string;
  parentVersionId:string | null;
  baseVersionId:string | null;
  deleted:boolean;
  manifest:unknown;
  /** Cloud chunk ids in file order (duplicates kept). */
  chunkIds:string[];
  declared:Array<{ id:string; cipherBytes:number; cipherSha256:string }>;
  /** Cloud ids sealed for this session and waiting in the staging directory. */
  staged:string[];
  uploadId:string | null;
  /** Declared chunks the server already held when the upload opened. */
  present:string[];
  namespaceKind?:'file'|'folder';
}

export interface SyncRow {
  collectionId:string;
  enabled:boolean;
  keyVersion:number;
  wrappedRoot:Envelope | null;
  lastSeq:number;
  head:SyncHead | null;
  status:SyncStatus;
  cloudCreated:boolean;
  escrowVaultId:string | null;
  escrowVaultEpoch:number | null;
  uploadSession:UploadSession | null;
}

export interface QueuedOperation {
  handle:string;
  collectionId:string;
  op:CloudOp;
  path:string;
  method:string;
  body:string | null;
  sha256:string;
  meta:Record<string, unknown>;
  attempts:number;
}

export interface PushCandidate {
  journalSeq:number;
  fileId:string;
  path:string;
  mime:string;
  versionId:string;
  parentVersionId:string | null;
  deleted:boolean;
  chunkCollectionId:string;
  chunkIds:string[];
  size:number;
  mtime:string;
  namespace?: { kind:'file'|'folder'; name:string; parentFolderId:string|null; operation:NamespaceOperation; restoredFromVersionId?:string };
}


/** What CloudPusher reads and records while staging a version (implemented by CloudPushStore). */
export interface CloudPushSource {
  pushCursor(collectionId:string):Promise<number>;
  chunkSize(collectionId:string, chunkId:string):Promise<{ size:number; storedSize:number } | null>;
  uploadedCopy(collectionId:string, localChunkId:string):Promise<{ cloudChunkId:string; cipherBytes:number; cipherSha256:string } | null>;
  recordSealedChunk(collectionId:string, localChunkId:string, cloudChunkId:string, cipherSha256:string, cipherBytes:number):Promise<void>;
  cloudHead(collectionId:string, fileId:string):Promise<string | null>;
}

/** The name push.ts still imports; it only ever used the CloudPushSource methods. */
export type PgCloudSyncRepository = CloudPushSource;
