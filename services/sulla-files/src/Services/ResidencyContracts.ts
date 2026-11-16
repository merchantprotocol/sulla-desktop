// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesKeyBundleContext } from '@sulla/vault-crypto';

export type ResidencyState = 'local' | 'evicting' | 'online-only' | 'hydrating' | 'error';

export interface RemoteChunkDescriptor {
  id:               string;
  size:             number;
  storedSize:       number;
  ciphertextSha256: string;
}

export interface RemoteVersionDescriptor {
  fileId:            string;
  versionId:         string;
  collectionId:      string;
  chunkCollectionId: string;
  manifestHash:      string;
  size:              number;
  chunks:            RemoteChunkDescriptor[];
  keyContext:        FilesKeyBundleContext;
}

export interface RemoteVersionReceipt {
  fileId:            string;
  versionId:         string;
  collectionId:      string;
  chunkCollectionId: string;
  manifestHash:      string;
  size:              number;
  remoteRevision:    string;
  chunks:            RemoteChunkDescriptor[];
  keyContext:        FilesKeyBundleContext;
}

/** Implementations must authenticate the server and bound every response. */
export interface AuthenticatedResidencyTransport {
  readonly authenticated: true;
  prepareVersion(version:RemoteVersionDescriptor, signal:AbortSignal):Promise<{ missingChunkIds: string[] }>;
  uploadChunk(input:{ versionId: string; collectionId: string; chunk: RemoteChunkDescriptor; ciphertext: Uint8Array; signal: AbortSignal }):Promise<void>;
  commitVersion(version:RemoteVersionDescriptor, signal:AbortSignal):Promise<void>;
  verifyVersion(version:RemoteVersionDescriptor, signal:AbortSignal):Promise<RemoteVersionReceipt>;
  downloadChunk(input:{ versionId: string; collectionId: string; chunk: RemoteChunkDescriptor; signal: AbortSignal }):Promise<AsyncIterable<Uint8Array>>;
}

/** The validated current version of a local file, with plaintext chunk geometry. */
export interface ResidencyVersion {
  fileId:            string;
  path:              string;
  versionId:         string;
  collectionId:      string;
  chunkCollectionId: string;
  manifestHash:      string;
  size:              number;
  chunks:            { id: string; size: number; storedSize: number }[];
}

export interface LocalValidation { contentHash: string; size: number; mtimeMs: number }
