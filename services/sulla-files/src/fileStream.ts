import { decryptAndVerifyChunk, maxEncryptedChunkBytes } from './crypto.js';
import { assertUnprotectedFile } from './protectedFiles.js';

import type { Config } from './config.js';
import type { Store } from './store.js';
import type express from 'express';
import type pg from 'pg';

export interface ByteRange { start:number; end:number }
const CHUNK_BYTES = 4 * 1024 * 1024;

export class RangeNotSatisfiableError extends Error {
  readonly status = 416;
  constructor(readonly size:number) { super('Requested range is not satisfiable') }
}

export function parseByteRange(header:string | undefined, size:number):ByteRange | undefined {
  if (!header) return undefined;
  if (!Number.isSafeInteger(size) || size < 0 || size === 0 || header.includes(',')) throw new RangeNotSatisfiableError(size);
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw new RangeNotSatisfiableError(size);
  let start:number;
  let end:number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeNotSatisfiableError(size);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new RangeNotSatisfiableError(size);
  return { start, end: Math.min(end, size - 1) };
}

interface StreamDescriptor {
  fileId:string;
  versionId:string;
  path:string;
  mime:string;
  size:number;
  chunkCollectionId:string;
  chunks:{ id:string; size:number; storedSize:number; start:number; end:number }[];
}

async function descriptor(db:pg.Pool, fileId:string, versionId?:string):Promise<StreamDescriptor | undefined> {
  const result = await db.query(
    `SELECT f.id,f.path,f.mime,v.id AS version_id,v.chunk_collection_id,v.size,m.total_size,m.chunk_ids
       FROM files f
       JOIN file_versions v ON v.id=COALESCE($2::uuid,f.current_version_id) AND v.file_id=f.id
       JOIN manifests m ON m.hash=v.manifest_hash
      WHERE f.id=$1 AND NOT v.deleted`,
    [fileId, versionId ?? null],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  await assertUnprotectedFile(db, row);
  const ids = Array.isArray(row.chunk_ids) ? row.chunk_ids.map(String) : [];
  const declared = Number(row.size);
  const expectedChunks = Math.max(1, Math.ceil(declared / CHUNK_BYTES));
  if (!Number.isSafeInteger(declared) || declared < 0 || ids.length !== expectedChunks) throw new Error('File manifest has invalid chunk geometry');
  const sizes = ids.length ? await db.query('SELECT id,size,stored_size FROM chunks WHERE collection_id=$1 AND id=ANY($2::text[])', [row.chunk_collection_id, ids]) : { rows: [] };
  const byId = new Map(sizes.rows.map(chunk => [String(chunk.id), { size: Number(chunk.size), storedSize: Number(chunk.stored_size) }]));
  const chunks:StreamDescriptor['chunks'] = [];
  let offset = 0;
  for (const [index, id] of ids.entries()) {
    const metadata = byId.get(id);
    const size = metadata?.size;
    const storedSize = metadata?.storedSize;
    const expectedSize = index < ids.length - 1 ? CHUNK_BYTES : declared - CHUNK_BYTES * (ids.length - 1);
    if (size === undefined || storedSize === undefined || !Number.isSafeInteger(size) || size !== expectedSize || size < 0 || size > CHUNK_BYTES || !Number.isSafeInteger(storedSize) || storedSize < 0 || storedSize > maxEncryptedChunkBytes(size)) throw new Error(`Missing or invalid chunk metadata for ${ id }`);
    chunks.push({ id, size, storedSize, start: offset, end: offset + size - 1 });
    offset += size;
  }
  if (!Number.isSafeInteger(declared) || declared < 0 || Number(row.total_size) !== declared || offset !== declared) throw new Error('File manifest size does not match its version');
  return { fileId: String(row.id), versionId: String(row.version_id), path: String(row.path), mime: String(row.mime || 'application/octet-stream'), size: declared, chunkCollectionId: String(row.chunk_collection_id), chunks };
}

export async function streamFileContent(db:pg.Pool, config:Config, store:Store, fileId:string, versionId:string | undefined, rangeHeader:string | undefined, signal:AbortSignal) {
  const file = await descriptor(db, fileId, versionId);
  if (!file) return undefined;
  const range = parseByteRange(rangeHeader, file.size);
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, file.size - 1);
  const keys = await config.keyring!.keys(file.chunkCollectionId);
  async function * body():AsyncGenerator<Buffer> {
    if (file!.size === 0) return;
    for (const chunk of file!.chunks) {
      if (chunk.end < start || chunk.start > end) continue;
      signal.throwIfAborted();
      const encrypted = await store.getBounded(file!.chunkCollectionId, chunk.id, maxEncryptedChunkBytes(chunk.size), chunk.storedSize);
      signal.throwIfAborted();
      const plain = await decryptAndVerifyChunk(encrypted, keys.data, keys.dedup, chunk.id, chunk.size);
      signal.throwIfAborted();
      const from = Math.max(0, start - chunk.start);
      const to = Math.min(chunk.size, end - chunk.start + 1);
      yield plain.subarray(from, to);
    }
  }
  return { ...file, range, contentLength: file.size === 0 ? 0 : end - start + 1, body: body() };
}

export async function sendFileStream(request:express.Request, response:express.Response, content:NonNullable<Awaited<ReturnType<typeof streamFileContent>>>, disposition?:string):Promise<void> {
  response.status(content.range ? 206 : 200);
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Type', content.mime);
  response.setHeader('Content-Length', content.contentLength);
  if (content.range) response.setHeader('Content-Range', `bytes ${ content.range.start }-${ content.range.end }/${ content.size }`);
  if (disposition) response.setHeader('Content-Disposition', disposition);
  if (request.method === 'HEAD' || content.contentLength === 0) { response.end(); return }
  for await (const part of content.body) {
    if (!response.write(part)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { response.off('drain', drained); response.off('close', closed) };
        const drained = () => { cleanup(); resolve() };
        const closed = () => { cleanup(); reject(Object.assign(new Error('Media stream cancelled'), { name: 'AbortError' })) };
      response.once('drain', drained); response.once('close', closed);
      });
    }
  }
  response.end();
}
