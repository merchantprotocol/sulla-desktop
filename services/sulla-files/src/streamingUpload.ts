// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import * as chunkCrypto from './crypto.js';
import { publishUploadChunk } from './uploadCleanup.js';
import { PublicationLifecyclePolicy } from './publicationLifecyclePolicy.js';
import { PlaintextChunkReader } from './plaintextChunkReader.js';
export { PlaintextChunkReader } from './plaintextChunkReader.js';

import type { FilesIdentity } from './auth.js';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { Readable } from 'node:stream';
import type pg from 'pg';


interface WinnerAwareCrypto {
  maxEncryptedChunkBytes(plainSize:number):number;
  decryptAndVerifyChunk(envelope:Uint8Array, dataKey:Uint8Array, dedupKey:Uint8Array, id:string, expectedPlainSize:number):Promise<Buffer>;
}

interface WinnerAwareStore {
  put(collectionId:string, id:string, envelope:Uint8Array):Promise<boolean>;
  getBounded(collectionId:string, id:string, maxBytes:number, expectedBytes:number):Promise<Buffer>;
}

interface StreamingUploadInput {
  uploadId:      string;
  collectionId:  string;
  path:          string;
  mime:          string;
  expectedBytes?: number;
  maxBytes?: number;
  actor:         FilesIdentity;
  body:          Readable;
  intentDb:      pg.Pool;
  existingFile?: { id:string; current_version_id:string };
  message?:      string;
}

async function assertManifestMetadata(client:pg.PoolClient, hash:string, chunkIds:string[], totalSize:number):Promise<void> {
  const inserted = await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING hash', [hash, JSON.stringify(chunkIds), totalSize]);
  if (inserted.rowCount) return;
  const existing = (await client.query('SELECT chunk_ids,total_size FROM manifests WHERE hash=$1', [hash])).rows[0];
  if (!existing || JSON.stringify(existing.chunk_ids) !== JSON.stringify(chunkIds) || Number(existing.total_size) !== totalSize) {
    throw new Error('Existing manifest metadata does not match uploaded content');
  }
}

async function assertChunkMetadata(client:pg.PoolClient, collectionId:string, chunk:{ id: string; size: number; storedSize: number }):Promise<void> {
  const location = `chunks/${ collectionId }/${ chunk.id }`;
  const inserted = await client.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount)
    VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING RETURNING id`, [collectionId, chunk.id, chunk.size, chunk.storedSize, location]);
  if (inserted.rowCount) return;
  const existing = (await client.query('SELECT size,stored_size,location FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId, chunk.id])).rows[0];
  if (!existing || Number(existing.size) !== chunk.size || Number(existing.stored_size) !== chunk.storedSize || existing.location !== location) {
    throw new Error('Existing chunk metadata does not match uploaded content');
  }
}

export interface StreamedUpload {
  chunkIds:string[];
  chunks:{ id: string; size: number; storedSize: number }[];
  totalSize:number;
  sourceHash:string;
}

/** Phase 1: read the request body, encrypt and publish chunks under the upload intent.
 * Uses no transaction, so a slow client never holds a database transaction or the
 * namespace lock open (idle-in-transaction is killed after 60 s). */
export async function streamUploadChunks(
  config:Config,
  store:Store,
  input:Pick<StreamingUploadInput, 'uploadId' | 'collectionId' | 'expectedBytes' | 'maxBytes' | 'body' | 'intentDb'>,
):Promise<StreamedUpload> {
  // These methods are supplied by the shared Files detail/media stack. Keeping
  // the contract explicit here lets this upload PR remain independently based
  // on the approved sharing head while the parent integrates both siblings.
  const crypto = chunkCrypto as typeof chunkCrypto & WinnerAwareCrypto;
  const chunkStore = store as unknown as WinnerAwareStore;
  const { data: dataKey, dedup: dedupKey } = await config.keyring!.keys(input.collectionId);
  const chunkIds:string[] = [];
  const chunks:{ id: string; size: number; storedSize: number }[] = [];
  const sourceHash = createHash('sha256');
  let totalSize = 0;

  for await (const plain of new PlaintextChunkReader(input.body, input.expectedBytes, input.maxBytes).chunks()) {
    totalSize += plain.byteLength;
    sourceHash.update(plain);
    const id = crypto.chunkId(plain, dedupKey);
    chunkIds.push(id);
    const encrypted = await crypto.encryptChunk(plain, dataKey, id);
    const maxStoredBytes = crypto.maxEncryptedChunkBytes(plain.byteLength);
    if (encrypted.byteLength > maxStoredBytes) throw new Error('Encrypted chunk exceeded its derived envelope bound');
    await publishUploadChunk(input.intentDb, input.uploadId, input.collectionId, id, async() => {
      const published = await chunkStore.put(input.collectionId, id, encrypted);
      if (!published) {
        const winner = await chunkStore.getBounded(input.collectionId, id, maxStoredBytes, encrypted.byteLength);
        await crypto.decryptAndVerifyChunk(winner, dataKey, dedupKey, id, plain.byteLength);
      }
    });
    chunks.push({ id, size: plain.byteLength, storedSize: encrypted.byteLength });
  }

  return { chunkIds, chunks, totalSize, sourceHash: sourceHash.digest('hex') };
}

/** Phase 2: short metadata transaction on `client` (caller holds BEGIN and the namespace lock). */
export async function commitStreamedUpload(
  client:pg.PoolClient,
  input:StreamingUploadInput,
  streamed:StreamedUpload,
):Promise<any> {
  const { chunkIds, chunks, totalSize } = streamed;
  const manifestHash = createHash('sha256').update(JSON.stringify({ ids: chunkIds, size: totalSize })).digest('hex');
  await assertManifestMetadata(client, manifestHash, chunkIds, totalSize);
  for (const chunk of chunks) await assertChunkMetadata(client, input.collectionId, chunk);
  const agentWrite = Boolean(input.actor.agentId || input.actor.jobId || input.actor.threadId);
  const collection = (await client.query('SELECT system_area FROM collections WHERE id=$1', [input.collectionId])).rows[0];
  const createdByType = agentWrite ? 'agent-run' : 'user';
  const createdById = input.actor.jobId ?? input.actor.agentId ?? input.actor.userId;
  const publicationStatus = new PublicationLifecyclePolicy().statusForWrite({ collection, path:input.path, createdByType });
  const file = input.existingFile
    ? (await client.query(`UPDATE files SET mime=$2,size=$3,updated_at=NOW() WHERE id=$1 RETURNING *`,
      [input.existingFile.id, input.mime, totalSize])).rows[0]
    : (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [input.collectionId, input.path, createdByType, createdById, input.mime, totalSize])).rows[0];
  const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id,publication_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10) RETURNING *`, [file.id, input.collectionId, input.existingFile?.current_version_id ?? null, manifestHash, totalSize, createdByType, createdById, input.message ?? 'Imported into Files', input.actor.deviceId || 'server-web', publicationStatus])).rows[0];
  await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [file.id, version.id]);
  await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [input.collectionId, chunkIds]);
  await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [input.collectionId, file.id, version.id]);
  await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [agentWrite ? 'agent-or-device' : 'user', createdById, input.actor.deviceId || null, file.id, version.id, version.publication_status === 'draft' ? 'draft-write' : 'upload', {path:input.path}]);
  return { ...file, current_version_id: version.id, size: totalSize, path: input.path, mime: input.mime, source_hash: streamed.sourceHash };
}

/** Both phases on one client (kept for the 64 MiB FUSE replace path). */
export async function insertStreamingUpload(
  client:pg.PoolClient,
  config:Config,
  store:Store,
  input:StreamingUploadInput,
):Promise<any> {
  return commitStreamedUpload(client, input, await streamUploadChunks(config, store, input));
}
