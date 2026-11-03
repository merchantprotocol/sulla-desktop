// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { NamespaceChunk, NamespaceManifest, NamespaceOperation } from './namespace.js';

export interface NamespaceEntry {
  itemId:string;
  kind:'file'|'folder';
  name:string;
  parentFolderId:string|null;
  mime?:string|null;
  size?:number;
  mtime:number;
  sha256?:string|null;
  chunks?:NamespaceChunk[];
  parentVersionId:string|null;
}

export type NamespaceEvent = NamespaceEntry & {
  operation?:NamespaceOperation;
  deleted?:boolean;
  restoredFromVersionId?:string;
};

/**
 * Converts a local Files/Finder event into the authenticated namespace payload.
 * The caller supplies the persisted itemId; paths are intentionally not accepted,
 * so a rename or move can never manufacture a new identity.
 */
export function serializeNamespaceEvent(event:NamespaceEvent):NamespaceManifest {
  const operation = event.operation ?? (event.deleted ? 'delete' : event.parentVersionId === null ? 'create' : 'content');
  const deleted = event.deleted ?? operation === 'delete';
  const folder = event.kind === 'folder';
  if (!event.itemId || !event.name || event.name.includes('/') || event.name.includes('\0')) throw new Error('invalid namespace entry');
  if (operation !== 'create' && event.parentVersionId === null) throw new Error('successor event requires parentVersionId');
  if (operation === 'restore' && !event.restoredFromVersionId) throw new Error('restore requires restoredFromVersionId');
  if (operation !== 'restore' && event.restoredFromVersionId !== undefined) throw new Error('restoredFromVersionId is only valid for restore');
  if (deleted || operation === 'delete') return {
    v:2, itemId:event.itemId, kind:event.kind, name:event.name, parentFolderId:event.parentFolderId,
    mime:folder ? null : (event.mime ?? null), size:0, mtime:event.mtime, sha256:null, chunks:[],
    deleted:true, parentVersionId:event.parentVersionId, operation:'delete',
  };
  const chunks = folder ? [] : [...(event.chunks ?? [])];
  const size = folder ? 0 : (event.size ?? chunks.reduce((total, chunk) => total + chunk[1], 0));
  const manifest:NamespaceManifest = {
    v:2, itemId:event.itemId, kind:event.kind, name:event.name, parentFolderId:event.parentFolderId,
    mime:folder ? null : (event.mime ?? null), size, mtime:event.mtime,
    sha256:folder ? null : (event.sha256 ?? null), chunks, deleted:false,
    parentVersionId:event.parentVersionId, operation,
  };
  if (operation === 'restore') manifest.restoredFromVersionId = event.restoredFromVersionId;
  return manifest;
}

export interface RecursiveDeleteBatch {
  batchId:string;
  type:'recursive-delete';
  rootItemId:string;
  index:number;
  final:boolean;
  versions:NamespaceManifest[];
}

/** Splits a verified subtree snapshot into signed, resumable tombstone batches. */
export function serializeRecursiveDelete(rootItemId:string, entries:NamespaceEvent[], batchId:string):RecursiveDeleteBatch[] {
  if (!batchId || !rootItemId) throw new Error('batchId and rootItemId are required');
  const tombstones = entries.map(entry => serializeNamespaceEvent({ ...entry, operation:'delete', deleted:true }));
  const batches:RecursiveDeleteBatch[] = [];
  for (let offset=0; offset<tombstones.length; offset+=256) {
    const versions = tombstones.slice(offset, offset + 256);
    batches.push({ batchId, type:'recursive-delete', rootItemId, index:batches.length, final:offset + versions.length === tombstones.length, versions });
  }
  if (!batches.length) batches.push({ batchId, type:'recursive-delete', rootItemId, index:0, final:true, versions:[] });
  return batches;
}
