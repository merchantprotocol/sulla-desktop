import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chunkId, decryptAndVerifyChunk, encryptChunk, maxEncryptedChunkBytes } from './crypto.js';
import { parseByteRange, RangeNotSatisfiableError, streamFileContent } from './fileStream.js';
import { Store } from './store.js';

import type { Config } from './config.js';
import type pg from 'pg';

test('byte ranges preserve exact media sizes and reject malformed or unsatisfiable ranges', () => {
  assert.deepEqual(parseByteRange(undefined, 100), undefined);
  assert.deepEqual(parseByteRange('bytes=0-0', 100), { start: 0, end: 0 });
  assert.deepEqual(parseByteRange('bytes=40-', 100), { start: 40, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-12', 100), { start: 88, end: 99 });
  assert.deepEqual(parseByteRange('bytes=80-999', 100), { start: 80, end: 99 });
  for (const value of ['items=0-1', 'bytes=', 'bytes=9-4', 'bytes=100-', 'bytes=0-1,4-5', 'bytes=-0']) {
    assert.throws(() => parseByteRange(value, 100), RangeNotSatisfiableError);
  }
  assert.throws(() => parseByteRange('bytes=0-', 0), RangeNotSatisfiableError);
});

test('streaming decrypts only intersecting bounded chunks and observes cancellation', async() => {
  const chunkBytes = 4 * 1024 * 1024;
  const key = randomBytes(32); const dedup = randomBytes(32);
  const firstPlain = Buffer.alloc(chunkBytes, 1); const secondPlain = Buffer.from('end');
  const firstId = chunkId(firstPlain, dedup); const secondId = chunkId(secondPlain, dedup);
  const encrypted = new Map([
    [firstId, await encryptChunk(firstPlain, key, firstId)],
    [secondId, await encryptChunk(secondPlain, key, secondId)],
  ]);
  const reads:string[] = [];
  const db = {
    query: (sql:string) => {
      if (sql.includes('FROM files f')) return Promise.resolve({ rows: [{ id: 'file', path: 'safe/video.mp4', mime: 'video/mp4', version_id: 'version', chunk_collection_id: 'collection', size: chunkBytes + 3, total_size: chunkBytes + 3, chunk_ids: [firstId, secondId] }] });
      if (sql.includes('files_protected_files')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (sql.includes('FROM chunks')) return Promise.resolve({ rows: [{ id: firstId, size: chunkBytes, stored_size: encrypted.get(firstId)!.length }, { id: secondId, size: 3, stored_size: encrypted.get(secondId)!.length }] });
      return Promise.reject(new Error(`Unexpected query: ${ sql }`));
    },
  } as unknown as pg.Pool;
  const store = { getBounded: (_collection:string, id:string, maxBytes:number, expectedBytes:number) => { reads.push(id); const bytes = encrypted.get(id)!; assert(bytes.length <= maxBytes); assert.equal(bytes.length, expectedBytes); return Promise.resolve(bytes) } } as unknown as Store;
  const config = { keyring: { keys: () => Promise.resolve({ data: key, dedup }) } } as unknown as Config;
  const controller = new AbortController();
  const content = await streamFileContent(db, config, store, 'file', 'version', `bytes=${ chunkBytes }-`, controller.signal);
  assert(content);
  const output:Buffer[] = [];
  for await (const part of content.body) output.push(part);
  assert.equal(Buffer.concat(output).toString(), 'end');
  assert.deepEqual(reads, [secondId]);
  const cancelled = await streamFileContent(db, config, store, 'file', 'version', undefined, controller.signal);
  controller.abort();
  await assert.rejects(cancelled!.body.next(), { name: 'AbortError' });
});

test('random incompressible chunks preserve an immutable winner across randomized encryption retries and ranges', async(t) => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root); const plain = randomBytes(4 * 1024 * 1024); const data = randomBytes(32); const dedup = randomBytes(32);
  const id = chunkId(plain, dedup); const first = await encryptChunk(plain, data, id); const retry = await encryptChunk(plain, data, id);
  assert.notDeepEqual(first, retry);
  assert(first.length > 4 * 1024 * 1024 + 1024);
  assert(first.length <= maxEncryptedChunkBytes(plain.length));
  assert.equal(await store.put('collection', id, first), true);
  assert.equal(await store.put('collection', id, retry), false);
  const winner = await store.getBounded('collection', id, maxEncryptedChunkBytes(plain.length), first.length);
  assert.deepEqual(winner, first);
  assert.deepEqual(await decryptAndVerifyChunk(winner, data, dedup, id, plain.length), plain);

  const db = {
    query: (sql:string) => {
      if (sql.includes('FROM files f')) return Promise.resolve({ rows: [{ id: 'file', path: 'safe/random.bin', mime: 'application/octet-stream', version_id: 'version', chunk_collection_id: 'collection', size: plain.length, total_size: plain.length, chunk_ids: [id] }] });
      if (sql.includes('files_protected_files')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (sql.includes('FROM chunks')) return Promise.resolve({ rows: [{ id, size: plain.length, stored_size: first.length }] });
      return Promise.reject(new Error(`Unexpected query: ${ sql }`));
    },
  } as unknown as pg.Pool;
  const config = { keyring: { keys: () => Promise.resolve({ data, dedup }) } } as unknown as Config;
  const content = await streamFileContent(db, config, store, 'file', 'version', `bytes=${ plain.length - 32 }-`, new AbortController().signal);
  assert(content);
  const output:Buffer[] = [];
  for await (const part of content.body) output.push(part);
  assert.deepEqual(Buffer.concat(output), plain.subarray(-32));

  await appendFile(store.path('collection', id), '!');
  await assert.rejects(store.getBounded('collection', id, maxEncryptedChunkBytes(plain.length), first.length), /longer than declared/);
});
