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

const MAX_MANIFEST_ENVELOPE_BYTES = 192 * 1024;
const MAX_DECLARED_CHUNKS = 4096;

export interface CommitRequest { body:string; sha256:string; head:SyncHead }

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
  const heads = new Map<string, StateEntry>();
  for (const entry of cloudHeads) heads.set(entry.fileId, entry);
  heads.set(committed.fileId, committed);
  return stateHash([...heads.values()]);
}

export async function buildCommit(sync:Pick<SyncRow, 'collectionId' | 'keyVersion' | 'lastSeq' | 'head'>, session:UploadSession, cloudHeads:StateEntry[], root:Uint8Array):Promise<CommitRequest> {
  const projected = await commitStateHash(cloudHeads, { fileId: session.fileId, versionId: session.versionId, deleted: session.deleted });
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
    versions: [{
      fileId: session.fileId,
      versionId: session.versionId,
      parentVersionId: session.parentVersionId,
      baseVersionId: session.baseVersionId,
      deleted: session.deleted,
      manifest: session.manifest,
      chunkIds: session.chunkIds,
    }],
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
    const keys = await this.keyring.keys(item.chunkCollectionId);
    const whole = createHash('sha256');
    const chunks:Array<[string, number]> = [];
    const declared = new Map<string, { id:string; cipherBytes:number; cipherSha256:string }>();
    const staged = new Set<string>();
    let total = 0;

    for (const localId of item.chunkIds) {
      const meta = await this.repository.chunkSize(item.chunkCollectionId, localId);
      if (!meta) throw new Error('Local chunk metadata is missing');
      const encrypted = await this.store.getBounded(item.chunkCollectionId, localId, meta.storedSize, meta.storedSize);
      const plain = await decryptAndVerifyChunk(encrypted, keys.data, keys.dedup, localId, meta.size);
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

    const manifestPlain:ManifestPlain = {
      v: 1,
      path: item.path,
      mime: item.mime,
      size: total,
      mtime: item.mtime,
      sha256: whole.digest('hex'),
      chunks,
      deleted: item.deleted,
      parentVersionId: item.parentVersionId,
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
    };
  }
}
