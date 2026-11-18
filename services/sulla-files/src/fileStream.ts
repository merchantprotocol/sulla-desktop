// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { defaultChunkCrypto, type ChunkCrypto } from './crypto.js';
import { assertUnprotectedFile } from './protectedFiles.js';
import { FileStreamRepository } from './Repositories/FileStreamRepository.js';

import type { Config } from './config.js';
import type { Store } from './store.js';
import type pg from 'pg';
import { sendFileStream } from './sendFileStream.js';
export { sendFileStream } from './sendFileStream.js';

export interface ByteRange { start:number; end:number }
const CHUNK_BYTES = 4 * 1024 * 1024;

/** Stored content that cannot be read as recorded. `integrityClass` matches files_fsck failure classes. */
export class FileContentIntegrityError extends Error {
  readonly status = 500;
  constructor(readonly integrityClass:'manifest_geometry_invalid' | 'chunk_row_missing' | 'chunk_metadata_invalid' | 'manifest_size_mismatch', message:string, readonly chunkId?:string) { super(message) }
}

/** A persisted chunk failed its AEAD or content-address check; callers must not retry it as a transient outage. */
export class ChunkKeyMismatchError extends Error {
  readonly status = 422;
  readonly code = 'chunk_key_mismatch';
  constructor(readonly collectionId:string, readonly chunkId:string, cause?:unknown) {
    super(`Stored chunk cannot be decrypted with its collection key: ${ chunkId }`, { cause });
  }
}

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

type ProtectedFileCheck = (db:Pick<pg.Pool, 'query'>, file:{ id:string; path:string }) => Promise<void>;

/**
 * Streams one file version's plaintext, optionally a byte range. Before any byte is read the
 * manifest geometry and every chunk row are validated; a version that cannot be read as
 * recorded fails with FileContentIntegrityError (files_fsck classes) instead of short content.
 */
export class FileContentStreamer {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Pick<Store, 'getBounded'>,
    private readonly versions = new FileStreamRepository(db),
    private readonly crypto:Pick<ChunkCrypto, 'maxEncryptedChunkBytes' | 'decryptAndVerifyChunk'> = defaultChunkCrypto,
    private readonly assertUnprotected:ProtectedFileCheck = assertUnprotectedFile,
  ) {}

  async stream(fileId:string, versionId:string | undefined, rangeHeader:string | undefined, signal:AbortSignal) {
    const file = await this.descriptor(fileId, versionId);
    if (!file) return undefined;
    const range = parseByteRange(rangeHeader, file.size);
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, file.size - 1);
    const keys = await this.config.keyring!.keys(file.chunkCollectionId);
    const { store, crypto } = this;
    async function * body():AsyncGenerator<Buffer> {
      if (file!.size === 0) return;
      for (const chunk of file!.chunks) {
        if (chunk.end < start || chunk.start > end) continue;
        signal.throwIfAborted();
        const encrypted = await store.getBounded(file!.chunkCollectionId, chunk.id, crypto.maxEncryptedChunkBytes(chunk.size), chunk.storedSize);
        signal.throwIfAborted();
        let plain:Buffer;
        console.info('[SullaFiles] chunk unwrap/decrypt', { collectionId:file!.chunkCollectionId, keyVersion:null, keyFingerprint:defaultChunkCrypto.keyFingerprint(keys.data) });
        try { plain = await crypto.decryptAndVerifyChunk(encrypted, keys.data, keys.dedup, chunk.id, chunk.size) }
        catch (error) {
          console.error('[SullaFiles] chunk unwrap/decrypt failure', { collectionId: file!.chunkCollectionId, keyVersion:null, keyFingerprint:defaultChunkCrypto.keyFingerprint(keys.data), chunkId: chunk.id });
          throw new ChunkKeyMismatchError(file!.chunkCollectionId, chunk.id, error);
        }
        signal.throwIfAborted();
        const from = Math.max(0, start - chunk.start);
        const to = Math.min(chunk.size, end - chunk.start + 1);
        yield plain.subarray(from, to);
      }
    }
    return { ...file, range, contentLength: file.size === 0 ? 0 : end - start + 1, body: body() };
  }

  private async descriptor(fileId:string, versionId?:string):Promise<StreamDescriptor | undefined> {
    const row = await this.versions.version(fileId, versionId);
    if (!row) return undefined;
    await this.assertUnprotected(this.db, row);
    const ids = Array.isArray(row.chunk_ids) ? row.chunk_ids.map(String) : [];
    const declared = Number(row.size);
    const expectedChunks = Math.max(1, Math.ceil(declared / CHUNK_BYTES));
    if (!Number.isSafeInteger(declared) || declared < 0 || ids.length !== expectedChunks) throw new FileContentIntegrityError('manifest_geometry_invalid', 'File manifest has invalid chunk geometry');
    const sizes = ids.length ? await this.versions.chunkSizes(row.chunk_collection_id, ids) : [];
    const byId = new Map(sizes.map(chunk => [String(chunk.id), { size: Number(chunk.size), storedSize: Number(chunk.stored_size) }]));
    const chunks:StreamDescriptor['chunks'] = [];
    let offset = 0;
    for (const [index, id] of ids.entries()) {
      const metadata = byId.get(id);
      const size = metadata?.size;
      const storedSize = metadata?.storedSize;
      const expectedSize = index < ids.length - 1 ? CHUNK_BYTES : declared - CHUNK_BYTES * (ids.length - 1);
      if (!metadata) throw new FileContentIntegrityError('chunk_row_missing', `Missing or invalid chunk metadata for ${ id }`, id);
      if (size === undefined || storedSize === undefined || !Number.isSafeInteger(size) || size !== expectedSize || size < 0 || size > CHUNK_BYTES || !Number.isSafeInteger(storedSize) || storedSize < 0 || storedSize > this.crypto.maxEncryptedChunkBytes(size)) throw new FileContentIntegrityError('chunk_metadata_invalid', `Missing or invalid chunk metadata for ${ id }`, id);
      chunks.push({ id, size, storedSize, start: offset, end: offset + size - 1 });
      offset += size;
    }
    if (!Number.isSafeInteger(declared) || declared < 0 || Number(row.total_size) !== declared || offset !== declared) throw new FileContentIntegrityError('manifest_size_mismatch', 'File manifest size does not match its version');
    return { fileId: String(row.id), versionId: String(row.version_id), path: String(row.path), mime: String(row.mime || 'application/octet-stream'), size: declared, chunkCollectionId: String(row.chunk_collection_id), chunks };
  }
}

/** Kept for app.ts, NativeCustody.ts, shares.ts and cloudRemote (outside this slice). */
export function streamFileContent(db:pg.Pool, config:Config, store:Store, fileId:string, versionId:string | undefined, rangeHeader:string | undefined, signal:AbortSignal) {
  return new FileContentStreamer(db, config, store).stream(fileId, versionId, rangeHeader, signal);
}
