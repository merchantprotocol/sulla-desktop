// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chunkId, encryptChunk } from '../src/crypto.js';
import { FilesRequestPipeline } from '../src/Http/FilesRequestPipeline.js';
import { ChunkIntegrityRepository } from '../src/Repositories/ChunkIntegrityRepository.js';
import { ChunkIntegrityQueryError, ChunkIntegrityScanner } from '../src/Services/ChunkIntegrityScanner.js';
import { Store } from '../src/store.js';

// risk: data integrity. The scan must flag a chunk that another key encrypted, and must not flag healthy chunks.
describe('chunk integrity scan (read-only)', () => {
  const collectionId = randomUUID();
  const plaintext = Buffer.from('PLAINTEXT-MARKER-chunk-integrity-spec');
  const dataKey = Buffer.alloc(32, 8), dedupKey = Buffer.alloc(32, 9);
  const otherDataKey = Buffer.alloc(32, 7), otherDedupKey = Buffer.alloc(32, 6);
  let root = '';
  let store:Store;
  let healthyId = '', wrongKeyId = '', missingId = '';
  let rows:{ id:string; size:number; storedSize:number }[] = [];
  const keyring = { keys: vi.fn(async() => ({ data: dataKey, dedup: dedupKey })) };
  const repository = {
    collectionIds: vi.fn(async(filter?:string) => (filter && filter !== collectionId ? [] : [collectionId])),
    chunkPage: vi.fn(async(_collection:string, afterId:string, limit:number) => rows.filter(row => row.id > afterId).slice(0, limit)),
  } as unknown as ChunkIntegrityRepository;

  beforeAll(async() => {
    root = await mkdtemp(join(tmpdir(), 'chunk-integrity-spec-'));
    store = new Store(root);
    healthyId = chunkId(plaintext, dedupKey);
    await store.put(collectionId, healthyId, await encryptChunk(plaintext, dataKey, healthyId));
    // Encrypted under a different collection key: the blob is well-formed, but the current key cannot verify it.
    const foreignPlain = Buffer.from('foreign chunk body');
    wrongKeyId = chunkId(foreignPlain, otherDedupKey);
    await store.put(collectionId, wrongKeyId, await encryptChunk(foreignPlain, otherDataKey, wrongKeyId));
    missingId = chunkId(Buffer.from('never written'), dedupKey);
    rows = [
      { id: healthyId, size: plaintext.length, storedSize: (await store.get(collectionId, healthyId)).length },
      { id: wrongKeyId, size: foreignPlain.length, storedSize: (await store.get(collectionId, wrongKeyId)).length },
      { id: missingId, size: 13, storedSize: 100 },
    ].sort((a, b) => a.id.localeCompare(b.id));
  });

  afterAll(async() => { if (root) await rm(root, { recursive: true, force: true }) });

  it('reports a chunk encrypted with another key as undecryptable, by id only', async() => {
    const report = await new ChunkIntegrityScanner(repository, store, { keys: keyring.keys }).scan({ collectionId });
    const collection = report.collections[0];
    expect(collection.undecryptable).toEqual([wrongKeyId]);
    expect(collection.missingBlob).toEqual([missingId]);
    expect(collection.errors).toBe(0);
    expect(report.totals).toMatchObject({ collections: 1, undecryptable: 1, missingBlob: 1 });
  });

  it('reports healthy chunks as healthy, not as failures', async() => {
    const report = await new ChunkIntegrityScanner(repository, store, { keys: keyring.keys }).scan({ collectionId });
    const collection = report.collections[0];
    expect(collection.chunksScanned).toBe(rows.length);
    expect(collection.undecryptable).not.toContain(healthyId);
    expect(collection.missingBlob).not.toContain(healthyId);
    expect(collection.keyFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('fingerprints the collection key and never returns plaintext or key material', async() => {
    const report = await new ChunkIntegrityScanner(repository, store, { keys: keyring.keys }).scan({ collectionId });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(plaintext.toString('utf8'));
    expect(serialized).not.toContain(dataKey.toString('hex'));
    expect(serialized).not.toContain(dedupKey.toString('hex'));
    expect(report.collections[0].keyFingerprint).toBe(ChunkIntegrityScanner.fingerprint(dataKey));
  });

  it('parses query parameters and rejects malformed ones', () => {
    expect(ChunkIntegrityScanner.parseOptions({ collectionId, limit: '25' })).toEqual({ collectionId, limit: 25 });
    expect(() => ChunkIntegrityScanner.parseOptions({ collectionId: 'not-a-uuid' })).toThrow(ChunkIntegrityQueryError);
    expect(() => ChunkIntegrityScanner.parseOptions({ limit: '0' })).toThrow(ChunkIntegrityQueryError);
    expect(() => ChunkIntegrityScanner.parseOptions({ limit: '100001' })).toThrow(ChunkIntegrityQueryError);
  });
});

// risk: permissions. The scan is a local-maintenance route; it must sit behind the local service token.
describe('chunk integrity route guard', () => {
  const token = 'local-token-for-spec';
  const config = { localToken: token } as never;
  const pipeline = new FilesRequestPipeline(config, () => true);

  function response() {
    const res = { statusCode: 200, body: undefined as unknown, status(code:number) { res.statusCode = code; return res }, json(body:unknown) { res.body = body; return res } };
    return res;
  }

  it('rejects /v1/local/chunk-integrity/scan without the local token', () => {
    const next = vi.fn();
    const res = response();
    pipeline.authenticate({ path: '/v1/local/chunk-integrity/scan', header: () => undefined } as never, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a wrong local token', () => {
    const next = vi.fn();
    const res = response();
    pipeline.authenticate({ path: '/v1/local/chunk-integrity/scan', header: (name:string) => (name === 'x-sulla-files-token' ? 'wrong' : undefined) } as never, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('admits the request with the local token', () => {
    const next = vi.fn();
    const res = response();
    pipeline.authenticate({ path: '/v1/local/chunk-integrity/scan', header: (name:string) => (name === 'x-sulla-files-token' ? token : undefined) } as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
