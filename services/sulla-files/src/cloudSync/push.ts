// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { decryptAndVerifyChunk } from '../crypto.js';
import type { FilesKeyring } from '../keyring.js';
import type { Store } from '../store.js';
import {
  chunkId,
  FLAG_DEFLATE_RAW,
  sealChunk,
  sealManifest,
  signHead,
  stateHash,
  type ManifestPlain,
  type StateEntry,
  type SyncHead,
} from './envelope.js';
import type { PgCloudSyncRepository, SyncRow, UploadSession } from './repository.js';
import type { CloudStagingStore } from './staging.js';
import { serializeNamespaceEvent, type RecursiveDeleteBatch } from './namespaceSerializer.js';

const MAX_MANIFEST_ENVELOPE_BYTES = 192 * 1024;
const MAX_DECLARED_CHUNKS = 4096;

export interface CommitRequest { body:string; sha256:string; head:SyncHead }
export type RecursiveDeleteMetadata=Omit<RecursiveDeleteBatch,'versions'>;

export interface RecursiveDeleteProgress { batchId:string; rootItemId:string; deviceId:string; nextIndex:number; sessions:UploadSession[] }
export interface RecursiveDeleteProgressStore {
  load(rootItemId:string):Promise<RecursiveDeleteProgress|null>;
  save(progress:RecursiveDeleteProgress):Promise<void>;
  clear(batchId:string):Promise<void>;
}
export interface NamespaceBatchStatus { rootItemId:string; deviceId:string; lastIndex:number; final:boolean }

/**
 * Drives already-staged tombstones through the commit sender. Progress is saved
 * after every acknowledged commit and reconciled with Cloud before resuming.
 */
export async function resumeRecursiveDeleteBatches(input:{
  batchId:string; rootItemId:string; deviceId:string; sessions:UploadSession[];
  progress:RecursiveDeleteProgressStore;
  status:(batchId:string)=>Promise<NamespaceBatchStatus|null>;
  send:(metadata:RecursiveDeleteMetadata,sessions:UploadSession[])=>Promise<void>;
}):Promise<void> {
  const local=await input.progress.load(input.rootItemId);
  if (local&&(local.batchId!==input.batchId||local.rootItemId!==input.rootItemId||local.deviceId!==input.deviceId)) throw new Error('recursive delete resume identity changed');
  const remote=await input.status(input.batchId);
  if (remote&&(remote.rootItemId!==input.rootItemId||remote.deviceId!==input.deviceId)) throw new Error('recursive delete remote identity changed');
  const sessions=local?.sessions??input.sessions;
  if(!local) await input.progress.save({batchId:input.batchId,rootItemId:input.rootItemId,deviceId:input.deviceId,nextIndex:0,sessions});
  const count=Math.ceil(sessions.length/256);
  let index=Math.max(local?.nextIndex??0,(remote?.lastIndex??-1)+1);
  for (;index<count;index++) {
    const part=sessions.slice(index*256,(index+1)*256);
    await input.send({batchId:input.batchId,type:'recursive-delete',rootItemId:input.rootItemId,index,final:index===count-1},part);
    await input.progress.save({batchId:input.batchId,rootItemId:input.rootItemId,deviceId:input.deviceId,nextIndex:index+1,sessions});
  }
  await input.progress.clear(input.batchId);
}

/** Re-pulls and re-enumerates after every final batch so concurrent descendants cannot escape deletion. */
export async function drainRecursiveDelete(input:{
  rootItemId:string; deviceId:string; initial:UploadSession[]; newBatchId:()=>string;
  progress:RecursiveDeleteProgressStore;
  status:(batchId:string)=>Promise<NamespaceBatchStatus|null>;
  send:(metadata:RecursiveDeleteMetadata,sessions:UploadSession[])=>Promise<void>;
  refreshAndEnumerate:()=>Promise<UploadSession[]>;
}):Promise<void> {
  let sessions=input.initial;
  while(sessions.length){
    const saved=await input.progress.load(input.rootItemId);
    await resumeRecursiveDeleteBatches({...input,batchId:saved?.batchId??input.newBatchId(),sessions});
    sessions=await input.refreshAndEnumerate();
  }
}

export function sha256Text(text:string):string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * stateHash for the head this commit creates: one entry per fileId, taken from
 * this device's view of every file's current cloud head, with the committed
 * version replacing its file's entry. Never computed from local files or from
 * the full list of pushed versions.
 */
export function commitStateHash(cloudHeads:StateEntry[], committed:StateEntry):Promise<string> {
  return commitStateHashMany(cloudHeads,[committed]);
}

export function commitStateHashMany(cloudHeads:StateEntry[], committed:StateEntry[]):Promise<string> {
  const heads = new Map<string, StateEntry>();
  for (const entry of cloudHeads) heads.set(entry.fileId, entry);
  for (const entry of committed) heads.set(entry.fileId, entry);
  return stateHash([...heads.values()]);
}

export async function buildCommit(sync:Pick<SyncRow, 'collectionId' | 'keyVersion' | 'lastSeq' | 'head'>, session:UploadSession, cloudHeads:StateEntry[], root:Uint8Array):Promise<CommitRequest> {
  return buildCommitBatch(sync,[session],cloudHeads,root);
}

/** Builds the exact signed body used by the commit transport for a bounded recursive delete. */
export async function buildCommitBatch(sync:Pick<SyncRow, 'collectionId' | 'keyVersion' | 'lastSeq' | 'head'>, sessions:UploadSession[], cloudHeads:StateEntry[], root:Uint8Array, batch?:RecursiveDeleteMetadata):Promise<CommitRequest> {
  if (!sessions.length || sessions.length>256) throw new Error('commit batch must contain 1 to 256 versions');
  if (batch && sessions.some(session=>!session.deleted)) throw new Error('recursive delete batches may contain only tombstones');
  const projected = await commitStateHashMany(cloudHeads,sessions.map(session=>({fileId:session.fileId,versionId:session.versionId,deleted:session.deleted})));
  const head = await signHead(root, {
    collectionId: sync.collectionId,
    keyVersion: sync.keyVersion,
    seq: sync.lastSeq + 1,
    stateHash: projected,
    prevMac: sync.head?.mac ?? '',
  });
  const body = JSON.stringify({
    baseSeq: sync.lastSeq,
    head,
    ...(batch?{batch}:{}),
    versions: sessions.map(session=>({
      fileId: session.fileId,
      versionId: session.versionId,
      parentVersionId: session.parentVersionId,
      baseVersionId: session.baseVersionId,
      deleted: session.deleted,
      manifest: session.manifest,
      chunkIds: session.chunkIds,
    })),
  });
  return { body, sha256: sha256Text(body), head };
}

/** Turns the next unpushed local version into an upload session: decrypt locally, re-seal for Cloud, stage wires. */
export class CloudPusher {
  /** The version the last stage() call picked, so a failure can skip just that file. */
  lastCandidate:{ fileId:string; versionId:string } | null = null;

  constructor(
    private readonly repository:PgCloudSyncRepository,
    private readonly store:Store,
    private readonly keyring:Pick<FilesKeyring, 'keys'>,
    private readonly staging:CloudStagingStore,
  ) {}

  async stage(sync:SyncRow, root:Uint8Array):Promise<UploadSession | null> {
    const cursor = await this.repository.pushCursor(sync.collectionId);
    const item = await this.repository.nextPushCandidate(sync.collectionId, cursor);
    this.lastCandidate = item ? { fileId: item.fileId, versionId: item.versionId } : null;
    if (!item) return null;
    const collectionId = sync.collectionId;
    // Chunks stored under another collection are re-sealed but not mapped, so P4 never evicts them on our word.
    const mapChunks = item.chunkCollectionId === collectionId;
    const keys = item.namespace?.kind === 'folder' ? null : await this.keyring.keys(item.chunkCollectionId);
    const whole = createHash('sha256');
    const chunks:Array<[string, number]> = [];
    const declared = new Map<string, { id:string; cipherBytes:number; cipherSha256:string }>();
    const staged = new Set<string>();
    let total = 0;

    for (const localId of item.chunkIds) {
      const meta = await this.repository.chunkSize(item.chunkCollectionId, localId);
      if (!meta) throw new Error('Local chunk metadata is missing');
      const encrypted = await this.store.getBounded(item.chunkCollectionId, localId, meta.storedSize, meta.storedSize);
      const plain = await decryptAndVerifyChunk(encrypted, keys!.data, keys!.dedup, localId, meta.size);
      try {
        whole.update(plain);
        total += plain.length;
        const known = mapChunks ? await this.repository.uploadedCopy(collectionId, localId) : null;
        if (known) {
          chunks.push([known.cloudChunkId, plain.length]);
          if (!declared.has(known.cloudChunkId)) declared.set(known.cloudChunkId, { id: known.cloudChunkId, cipherBytes: known.cipherBytes, cipherSha256: known.cipherSha256 });
          continue;
        }
        const id = await chunkId(root, collectionId, sync.keyVersion, plain);
        chunks.push([id, plain.length]);
        if (declared.has(id)) continue;
        const compressed = deflateRawSync(plain);
        const useCompression = compressed.length <= Math.floor(plain.length * 0.95);
        const wire = await sealChunk(root, collectionId, sync.keyVersion, id, useCompression ? compressed : plain, useCompression ? FLAG_DEFLATE_RAW : 0);
        const cipherSha256 = createHash('sha256').update(wire).digest('hex');
        await this.staging.put(collectionId, id, wire);
        if (mapChunks) await this.repository.recordSealedChunk(collectionId, localId, id, cipherSha256, wire.length);
        declared.set(id, { id, cipherBytes: wire.length, cipherSha256 });
        staged.add(id);
      } finally {
        plain.fill(0);
      }
    }
    if (total !== item.size) throw new Error('Local version size does not match its chunks');
    if (declared.size > MAX_DECLARED_CHUNKS) throw new Error('File has too many chunks for one upload');

    const digest = whole.digest('hex');
    const manifestPlain:ManifestPlain | ReturnType<typeof serializeNamespaceEvent> = item.namespace
      ? serializeNamespaceEvent({
          itemId:item.fileId, kind:item.namespace.kind, name: item.namespace.name, parentFolderId: item.namespace.parentFolderId,
          mime: item.mime, size: total, mtime: Math.trunc(new Date(item.mtime).getTime()), sha256: digest,
          chunks, deleted: item.deleted, parentVersionId:item.parentVersionId, operation:item.namespace.operation, restoredFromVersionId:item.namespace.restoredFromVersionId,
        })
      : {
          v: 1, path: item.path, mime: item.mime, size: total, mtime: item.mtime, sha256: digest,
          chunks, deleted: item.deleted, parentVersionId: item.parentVersionId,
        };
    const manifest = await sealManifest(root, collectionId, sync.keyVersion, item.fileId, item.versionId, manifestPlain);
    if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_ENVELOPE_BYTES) throw new Error('File manifest exceeds the 192 KiB limit');

    return {
      journalSeq: item.journalSeq,
      fileId: item.fileId,
      versionId: item.versionId,
      parentVersionId: item.parentVersionId,
      // The version this device last saw as the file's cloud head; null only for files never in Cloud.
      baseVersionId: await this.repository.cloudHead(collectionId, item.fileId),
      deleted: item.deleted,
      manifest,
      chunkIds: chunks.map(([id]) => id),
      declared: [...declared.values()],
      staged: [...staged],
      uploadId: null,
      present: [],
      namespaceKind:item.namespace?.kind,
    };
  }
}
