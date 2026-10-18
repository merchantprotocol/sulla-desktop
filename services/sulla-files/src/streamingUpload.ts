import { createHash } from 'node:crypto';

import * as chunkCrypto from './crypto.js';
import { publishUploadChunk } from './uploadCleanup.js';

import type { FilesIdentity } from './auth.js';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { Readable } from 'node:stream';
import type pg from 'pg';

const CHUNK_BYTES = 4 * 1024 * 1024;

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
  expectedBytes: number;
  actor:         FilesIdentity;
  body:          Readable;
  intentDb:      pg.Pool;
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

async function * plaintextChunks(body:Readable, expectedBytes:number):AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0);
  let total = 0;
  for await (const value of body) {
    const incoming = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += incoming.byteLength;
    if (total > expectedBytes) throw new Error('Upload exceeded its declared size');
    pending = pending.byteLength ? Buffer.concat([pending, incoming]) : incoming;
    while (pending.byteLength >= CHUNK_BYTES) {
      yield pending.subarray(0, CHUNK_BYTES);
      pending = pending.subarray(CHUNK_BYTES);
    }
  }
  if (total !== expectedBytes) throw new Error('Upload did not match its declared size');
  if (pending.byteLength || total === 0) yield pending;
}

export async function insertStreamingUpload(
  client:pg.PoolClient,
  config:Config,
  store:Store,
  input:StreamingUploadInput,
):Promise<any> {
  // These methods are supplied by the shared Files detail/media stack. Keeping
  // the contract explicit here lets this upload PR remain independently based
  // on the approved sharing head while the parent integrates both siblings.
  const crypto = chunkCrypto as typeof chunkCrypto & WinnerAwareCrypto;
  const chunkStore = store as unknown as WinnerAwareStore;
  const { data: dataKey, dedup: dedupKey } = await config.keyring!.keys(input.collectionId);
  const chunkIds:string[] = [];
  const chunks:{ id: string; size: number; storedSize: number }[] = [];
  let totalSize = 0;

  for await (const plain of plaintextChunks(input.body, input.expectedBytes)) {
    totalSize += plain.byteLength;
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

  const manifestHash = createHash('sha256').update(JSON.stringify({ ids: chunkIds, size: totalSize })).digest('hex');
  await assertManifestMetadata(client, manifestHash, chunkIds, totalSize);
  for (const chunk of chunks) await assertChunkMetadata(client, input.collectionId, chunk);
  const file = (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size)
    VALUES($1,$2,'user',$3,$4,$5) RETURNING *`, [input.collectionId, input.path, input.actor.userId, input.mime, totalSize])).rows[0];
  const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id)
    VALUES($1,$2,NULL,$3,$4,'user',$5,'Imported from Mac',$6,NULL) RETURNING *`, [file.id, input.collectionId, manifestHash, totalSize, input.actor.userId, input.actor.deviceId || 'server-web'])).rows[0];
  await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [file.id, version.id]);
  await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [input.collectionId, chunkIds]);
  await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [input.collectionId, file.id, version.id]);
  await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
    VALUES($1,$2,$3,$4,$5,'upload',$6)`, [input.actor.kind === 'capability' ? 'agent-or-device' : 'user', input.actor.userId, input.actor.deviceId || null, file.id, version.id, {}]);
  return { ...file, current_version_id: version.id, size: totalSize, path: input.path, mime: input.mime };
}
