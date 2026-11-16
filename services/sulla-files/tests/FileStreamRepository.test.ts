// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Real Postgres: the content read path's version/manifest lookup and its integrity checks.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chunkId, encryptChunk } from '../src/crypto.js';
import { FileContentIntegrityError, FileContentStreamer } from '../src/fileStream.js';
import { FileStreamRepository } from '../src/Repositories/FileStreamRepository.js';
import { Store } from '../src/store.js';
import { ChunkSchemaFixture } from './ChunkSchemaFixture.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('file content stream lookup (real Postgres)', () => {
  const f = new ChunkSchemaFixture(databaseUrl ?? '');
  const versions = new FileStreamRepository(f.pool);
  const dataKey = Buffer.alloc(32, 4), dedupKey = Buffer.alloc(32, 5);
  const config = { keyring: { keys: async() => ({ data: dataKey, dedup: dedupKey }) } } as any;
  const allowAll = async() => undefined;
  let root = '';
  let store:Store;

  beforeAll(async() => { await f.create(); root = await mkdtemp(join(tmpdir(), 'sulla-file-stream-spec-')); store = new Store(root) });
  afterAll(async() => { await f.drop(); if (root) await rm(root, { recursive: true, force: true }) });
  beforeEach(async() => { await f.reset() });

  async function storedFile(collectionId:string, content:Buffer) {
    const id = chunkId(content, dedupKey);
    const envelope = await encryptChunk(content, dataKey, id);
    await store.put(collectionId, id, envelope);
    await f.chunk(collectionId, id, content.length, envelope.length);
    const manifest = await f.manifest([id], content.length);
    return { id, ...await f.file(collectionId, manifest, content.length) };
  }
  async function drain(body:AsyncGenerator<Buffer>):Promise<Buffer> {
    const parts:Buffer[] = []; for await (const part of body) parts.push(part); return Buffer.concat(parts);
  }

  it('resolves the current or a named version, never a deleted one', async() => {
    // risk: data integrity — a deleted version must not be served as content.
    const c = await f.collection();
    const { fileId, versionId, id } = await storedFile(c, Buffer.from('hello world'));
    expect(await versions.version(fileId)).toMatchObject({ id: fileId, version_id: versionId, chunk_collection_id: c, chunk_ids: [id] });
    expect(await versions.version(fileId, versionId)).toMatchObject({ version_id: versionId });
    await f.pool.query('UPDATE file_versions SET deleted=TRUE WHERE id=$1', [versionId]);
    expect(await versions.version(fileId)).toBeUndefined();
  });

  it('reads chunk sizes only from the version collection', async() => {
    // risk: tenant isolation — chunk metadata of another collection must never size this file.
    const c = await f.collection(); const other = await f.collection(); const id = ChunkSchemaFixture.chunkId();
    await f.chunk(other, id, 9, 99);
    expect(await versions.chunkSizes(c, [id])).toEqual([]);
    expect(await versions.chunkSizes(other, [id])).toEqual([{ id, size: 9, stored_size: 99 }]);
  });

  it('streams exact bytes, honours a byte range, and fails loudly when a chunk row is missing', async() => {
    // risk: data integrity — a version whose chunk row is gone must fail as chunk_row_missing, never return short content.
    const c = await f.collection();
    const { fileId, id } = await storedFile(c, Buffer.from('0123456789'));
    const streamer = new FileContentStreamer(f.pool, config, store, versions, undefined, allowAll);
    const whole = await streamer.stream(fileId, undefined, undefined, new AbortController().signal);
    expect((await drain(whole!.body)).toString()).toBe('0123456789');
    const ranged = await streamer.stream(fileId, undefined, 'bytes=2-5', new AbortController().signal);
    expect(ranged!.contentLength).toBe(4);
    expect((await drain(ranged!.body)).toString()).toBe('2345');

    await f.pool.query('ALTER TABLE chunks DISABLE TRIGGER files_guard_chunk_delete');
    try { await f.pool.query('DELETE FROM chunks WHERE collection_id=$1 AND id=$2', [c, id]) } finally { await f.pool.query('ALTER TABLE chunks ENABLE TRIGGER files_guard_chunk_delete') }
    const error = await streamer.stream(fileId, undefined, undefined, new AbortController().signal).catch(caught => caught);
    expect(error).toBeInstanceOf(FileContentIntegrityError);
    expect(error).toMatchObject({ integrityClass: 'chunk_row_missing', chunkId: id, status: 500 });
  });

  it('rejects a version whose manifest size disagrees with its recorded size', async() => {
    // risk: data integrity — mismatched geometry must fail before any byte is served.
    const c = await f.collection(); const id = ChunkSchemaFixture.chunkId();
    await f.chunk(c, id, 10, 100);
    const { fileId } = await f.file(c, await f.manifest([id], 11), 10);
    const streamer = new FileContentStreamer(f.pool, config, store, versions, undefined, allowAll);
    await expect(streamer.stream(fileId, undefined, undefined, new AbortController().signal)).rejects.toMatchObject({ integrityClass: 'manifest_size_mismatch' });
  });
});
