// Sulla Desktop · https://sulladesktop.com.
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChunkCrypto, chunkId, encryptChunk } from '../src/crypto.js';
import { FilesRequestPipeline } from '../src/Http/FilesRequestPipeline.js';
import { ChunkIntegrityRepository } from '../src/Repositories/ChunkIntegrityRepository.js';
import { ChunkIntegrityQueryError, ChunkIntegrityScanner, type ChunkFailure, type ChunkIntegrityScanReport } from '../src/Services/ChunkIntegrityScanner.js';
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

// risk: data integrity. Each failing chunk must be classified by the stage it died at, so an operator can tell a wrong key from a size or identity mismatch.
describe('chunk failure stages and key diagnosis (read-only)', () => {
  const collectionA = randomUUID();
  const collectionB = randomUUID();
  const keysA = { data: Buffer.alloc(32, 0x08), dedup: Buffer.alloc(32, 0x09) };
  const keysB = { data: Buffer.alloc(32, 0x07), dedup: Buffer.alloc(32, 0x06) };
  const strangerDataKey = Buffer.alloc(32, 0x33);
  const otherDedupKey = Buffer.alloc(32, 0x55);
  const zeroDataKey = Buffer.alloc(32, 0);
  const crypto = new ChunkCrypto();
  const plainMarker = 'PLAINTEXT-MARKER-stage-spec';
  const keyring = {
    keys: vi.fn(async(id:string) => {
      if (id === collectionA) return keysA;
      if (id === collectionB) return keysB;
      throw new Error('no key for collection');
    }),
  };
  const rowsByCollection = new Map<string, { id:string; size:number; storedSize:number }[]>();
  const repository = {
    collectionIds: vi.fn(async(filter?:string) => (filter ? [filter] : [collectionA, collectionB])),
    chunkPage: vi.fn(async(collection:string, afterId:string, limit:number) => (rowsByCollection.get(collection) ?? [])
      .filter(row => row.id > afterId).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit)),
  } as unknown as ChunkIntegrityRepository;
  let root = '';
  let store:Store;
  let healthyId = '', sizedId = '', foreignId = '', strangerId = '', identityId = '', zeroId = '', notEnvelopeId = '', notZstdId = '';
  let sizedPlainBytes = 0;

  async function writeChunk(collection:string, id:string, blob:Buffer, size:number):Promise<void> {
    await store.put(collection, id, blob);
    const rows = rowsByCollection.get(collection) ?? [];
    rows.push({ id, size, storedSize: (await store.get(collection, id)).length });
    rowsByCollection.set(collection, rows);
  }

  function failureFor(report:ChunkIntegrityScanReport, id:string):ChunkFailure | undefined {
    return report.collections[0].failures.find(failure => failure.chunkId === id);
  }

  beforeAll(async() => {
    root = await mkdtemp(join(tmpdir(), 'chunk-stage-spec-'));
    store = new Store(root);

    const healthy = Buffer.from(`${ plainMarker } healthy`);
    healthyId = chunkId(healthy, keysA.dedup);
    await writeChunk(collectionA, healthyId, await encryptChunk(healthy, keysA.data, healthyId), healthy.length);

    // Correct key, correct id, but the row claims a different size: the plaintext length is the stage evidence.
    const sized = Buffer.from(`${ plainMarker } sized`);
    sizedPlainBytes = sized.length;
    sizedId = chunkId(sized, keysA.dedup);
    await writeChunk(collectionA, sizedId, await encryptChunk(sized, keysA.data, sizedId), sized.length + 7);

    // Sealed under collection B's data key, so collection A's key fails with aead and B's key opens it.
    const foreign = Buffer.from(`${ plainMarker } foreign`);
    foreignId = chunkId(foreign, keysA.dedup);
    await writeChunk(collectionA, foreignId, await encryptChunk(foreign, keysB.data, foreignId), foreign.length);

    // Sealed under a key no collection owns: aead for every collection.
    const stranger = Buffer.from(`${ plainMarker } stranger`);
    strangerId = chunkId(stranger, keysA.dedup);
    await writeChunk(collectionA, strangerId, await encryptChunk(stranger, strangerDataKey, strangerId), stranger.length);

    // Correct data key and AAD, but the id was derived from a different dedup key.
    const identity = Buffer.from(`${ plainMarker } identity`);
    identityId = chunkId(identity, otherDedupKey);
    await writeChunk(collectionA, identityId, await encryptChunk(identity, keysA.data, identityId), identity.length);

    // Sealed under an all-zero data key: diagnose must report "zero-key", not a collection.
    const zeroSealed = Buffer.from('zero key body');
    zeroId = chunkId(zeroSealed, keysA.dedup);
    // Build a regression fixture with the actual AEAD primitive: production ChunkCrypto.encrypt
    // correctly refuses zero keys, while the diagnostic must still identify legacy zero-key blobs.
    await sodium.ready;
    const zeroNonce = Buffer.alloc(24, 0x17);
    const zeroCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(zeroSealed, Buffer.from(`sulla:file-chunk:v1:${ zeroId }`), null, zeroNonce, zeroDataKey);
    const zeroEnvelope = Buffer.from(JSON.stringify({ version:1, algorithm:'xchacha20-poly1305', nonce:zeroNonce.toString('base64url'), ciphertext:Buffer.from(zeroCiphertext).toString('base64url') }));
    await writeChunk(collectionA, zeroId, zeroEnvelope, zeroSealed.length);

    notEnvelopeId = chunkId(Buffer.from('not an envelope'), keysA.dedup);
    await writeChunk(collectionA, notEnvelopeId, Buffer.from('not an envelope {'), 8);

    // Valid AEAD envelope whose plaintext is not zstd.
    notZstdId = chunkId(Buffer.from('not zstd'), keysA.dedup);
    const sealedNotZstd = await crypto.encrypt(Buffer.from('not zstd bytes'), keysA.data, `sulla:file-chunk:v1:${ notZstdId }`);
    await writeChunk(collectionA, notZstdId, Buffer.from(JSON.stringify(sealedNotZstd)), 14);
  });

  afterAll(async() => { if (root) await rm(root, { recursive: true, force: true }) });

  it('classifies each failing chunk by the stage it died at', async() => {
    const report = await new ChunkIntegrityScanner(repository, store, keyring).scan({ collectionId: collectionA });
    const stageById = Object.fromEntries(report.collections[0].failures.map(failure => [failure.chunkId, failure.stage]));
    expect(stageById).toEqual({
      [sizedId]: 'size_mismatch',
      [foreignId]: 'aead',
      [strangerId]: 'aead',
      [zeroId]: 'aead',
      [identityId]: 'identity_mismatch',
      [notEnvelopeId]: 'envelope_parse',
      [notZstdId]: 'decompress',
    });
    expect(report.collections[0].undecryptable).toEqual(Object.keys(stageById).sort());
    expect(report.collections[0].undecryptable).not.toContain(healthyId);
  });

  it('reports the actual decompressed length, and no plainBytes for other stages', async() => {
    const report = await new ChunkIntegrityScanner(repository, store, keyring).scan({ collectionId: collectionA });
    expect(failureFor(report, sizedId)).toEqual({ chunkId: sizedId, stage: 'size_mismatch', plainBytes: sizedPlainBytes });
    expect(failureFor(report, foreignId)).not.toHaveProperty('plainBytes');
    expect(failureFor(report, identityId)).not.toHaveProperty('plainBytes');
  });

  it('adds no opensWith without diagnose=1', async() => {
    const report = await new ChunkIntegrityScanner(repository, store, keyring).scan({ collectionId: collectionA });
    expect(failureFor(report, foreignId)).not.toHaveProperty('opensWith');
  });

  it('with diagnose, names the other collection whose data key opens an aead failure, by id and fingerprint only', async() => {
    const report = await new ChunkIntegrityScanner(repository, store, keyring).scan({ collectionId: collectionA, diagnose: true });
    expect(failureFor(report, foreignId)?.opensWith).toEqual({ collectionId: collectionB, keyFingerprint: ChunkIntegrityScanner.fingerprint(keysB.data) });
    expect(failureFor(report, strangerId)?.opensWith).toBeNull();
    expect(failureFor(report, zeroId)?.opensWith).toBe('zero-key');
    expect(failureFor(report, sizedId)).not.toHaveProperty('opensWith');
    expect(failureFor(report, identityId)).not.toHaveProperty('opensWith');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(plainMarker);
    for (const key of [keysA.data, keysA.dedup, keysB.data, keysB.dedup, strangerDataKey, otherDedupKey, zeroDataKey]) expect(serialized).not.toContain(key.toString('hex'));
  });

  it('parses diagnose as 1 or 0 and rejects anything else', () => {
    expect(ChunkIntegrityScanner.parseOptions({ diagnose: '1' })).toEqual({ diagnose: true });
    expect(ChunkIntegrityScanner.parseOptions({ diagnose: '0' })).toEqual({ diagnose: false });
    expect(ChunkIntegrityScanner.parseOptions({})).toEqual({});
    expect(() => ChunkIntegrityScanner.parseOptions({ diagnose: 'yes' })).toThrow(ChunkIntegrityQueryError);
  });
});

// risk: data integrity. The cross-collection probe is capped per request so one scan cannot run unbounded key unwraps.
describe('chunk diagnosis cap (read-only)', () => {
  const collection = randomUUID();
  const other = randomUUID();
  const keysCollection = { data: Buffer.alloc(32, 0x21), dedup: Buffer.alloc(32, 0x22) };
  const keysOther = { data: Buffer.alloc(32, 0x23), dedup: Buffer.alloc(32, 0x24) };
  let root = '';
  let store:Store;
  const rows:{ id:string; size:number; storedSize:number }[] = [];

  beforeAll(async() => {
    root = await mkdtemp(join(tmpdir(), 'chunk-diagnose-cap-spec-'));
    store = new Store(root);
    for (let index = 0; index < 51; index += 1) {
      const plain = Buffer.from(`cap-chunk-${ index }`);
      const id = chunkId(plain, keysCollection.dedup);
      const blob = await encryptChunk(plain, keysOther.data, id);
      await store.put(collection, id, blob);
      rows.push({ id, size: plain.length, storedSize: blob.length });
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  });

  afterAll(async() => { if (root) await rm(root, { recursive: true, force: true }) });

  it('diagnoses at most 50 failing chunks per request', async() => {
    const keyring = {
      keys: vi.fn(async(id:string) => {
        if (id === collection) return keysCollection;
        if (id === other) return keysOther;
        throw new Error('no key for collection');
      }),
    };
    const repository = {
      collectionIds: vi.fn(async(filter?:string) => (filter ? [filter] : [collection, other])),
      chunkPage: vi.fn(async(_collection:string, afterId:string, limit:number) => rows.filter(row => row.id > afterId).slice(0, limit)),
    } as unknown as ChunkIntegrityRepository;

    const report = await new ChunkIntegrityScanner(repository, store, keyring).scan({ collectionId: collection, diagnose: true });
    const failures = report.collections[0].failures;
    expect(failures).toHaveLength(51);
    const diagnosed = failures.filter(failure => failure.opensWith !== undefined);
    expect(diagnosed).toHaveLength(50);
    expect(diagnosed.every(failure => failure.opensWith?.collectionId === other)).toBe(true);
    expect(failures.filter(failure => failure.opensWith === undefined)).toHaveLength(1);
  });
});
