// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Wire shapes of Sulla Files sync envelope v1 (FILES-SYNC-DESIGN.md §3). Codecs: SyncEnvelopeCodec, SyncEscrowCodec.

export type SubkeyPurpose = 'chunk-id' | 'chunk' | 'manifest' | 'head' | 'info';

export interface ManifestPlain {
  v:1;
  path:string;
  /** Missing means file for v1 compatibility. */
  kind?:'file' | 'folder';
  mime:string;
  size:number;
  mtime:string;
  sha256:string;
  chunks:Array<[string, number]>;
  deleted:boolean;
  parentVersionId:string | null;
}

/** Goal N's additive plaintext namespace. The surrounding crypto envelope stays v1. */
export interface NamespaceManifestPlain {
  v:2;
  itemId:string;
  kind:'file' | 'folder';
  name:string;
  parentFolderId:string | null;
  mime:string | null;
  size:number;
  mtime:number;
  sha256:string | null;
  chunks:Array<[string, number]>;
  deleted:boolean;
  parentVersionId:string | null;
  operation:'create' | 'content' | 'metadata' | 'delete' | 'restore';
  restoredFromVersionId?:string;
}

export interface ManifestEnvelope {
  format:'sulla-files-sync-manifest';
  v:1;
  alg:'A256GCM';
  collectionId:string;
  keyVersion:number;
  fileId:string;
  versionId:string;
  nonce:string;
  ct:string;
}

export interface SyncHead {
  format:'sulla-files-sync-head';
  v:1;
  collectionId:string;
  keyVersion:number;
  seq:number;
  stateHash:string;
  prevMac:string;
  mac:string;
}

export interface EscrowEnvelope {
  format:'sulla-files-sync-escrow';
  v:1;
  alg:'A256GCM';
  kdf:'HKDF-SHA256';
  vaultId:string;
  vaultEpoch:number;
  collectionId:string;
  keyVersion:number;
  nonce:string;
  ct:string;
}

export interface TransportEnvelope {
  format:'sulla-files-sync-transport';
  v:1;
  alg:'ECDH-P256+HKDF-SHA256+A256GCM';
  epk:string;
  nonce:string;
  ct:string;
}

/** The collection's folder name, sealed with its root so a new device restores it under the same name. */
export interface CollectionInfoEnvelope {
  format:'sulla-files-sync-collection-info';
  v:1;
  alg:'A256GCM';
  collectionId:string;
  keyVersion:number;
  nonce:string;
  ct:string;
}

export interface CollectionInfoPlain { v:1; name:string }

export interface StateEntry { fileId:string; versionId:string; deleted:boolean }
