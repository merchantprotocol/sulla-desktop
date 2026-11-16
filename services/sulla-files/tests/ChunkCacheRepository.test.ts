// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Real Postgres: the chunk cache ledger and the evictor that deletes local blobs.
// Point SULLA_FILES_TEST_DATABASE_URL at a throwaway database; each run uses its own schema.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChunkCacheRepository } from '../src/Repositories/ChunkCacheRepository.js';
import { ChunkCacheEvictor } from '../src/chunkCache/evictor.js';
import { Store } from '../src/store.js';
import { ChunkSchemaFixture } from './ChunkSchemaFixture.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('chunk cache ledger and eviction (real Postgres)', () => {
  const f = new ChunkSchemaFixture(databaseUrl ?? '');
  const cache = new ChunkCacheRepository(f.pool);
  let root = '';
  let store:Store;

  beforeAll(async() => { await f.create(); root = await mkdtemp(join(tmpdir(), 'sulla-chunk-cache-spec-')); store = new Store(root) });
  afterAll(async() => { await f.drop(); if (root) await rm(root, { recursive: true, force: true }) });
  beforeEach(async() => { await f.reset() });

  async function resident(collectionId:string, id:string, storedBytes:number, readAgo:string | null) {
    await f.pool.query(`INSERT INTO files_chunk_cache(collection_id,chunk_id,state,stored_bytes,last_read_at)
      VALUES($1,$2,'resident',$3,CASE WHEN $4::interval IS NULL THEN NULL ELSE NOW()-$4::interval END)`, [collectionId, id, storedBytes, readAgo]);
  }
  async function row(collectionId:string, id:string) {
    return (await f.pool.query('SELECT state,stored_bytes,evicted_at FROM files_chunk_cache WHERE collection_id=$1 AND chunk_id=$2', [collectionId, id])).rows[0];
  }

  it('offers never-read chunks first, then oldest-read, and never recent, protected or non-resident chunks', async() => {
    // risk: data availability — evicting a chunk that is being read, or a protected one, loses offline access.
    const c = await f.collection();
    const [neverRead, twoHours, tenMinutes, recent, guarded, evicted] = Array.from({ length: 6 }, () => ChunkSchemaFixture.chunkId());
    await resident(c, twoHours, 10, '2 hours');
    await resident(c, tenMinutes, 10, '10 minutes');
    await resident(c, neverRead, 10, null);
    await resident(c, recent, 10, '1 minute');
    await resident(c, guarded, 10, '3 hours');
    await f.pool.query('INSERT INTO files_protected_chunks(collection_id,chunk_id) VALUES($1,$2)', [c, guarded]);
    await f.pool.query("INSERT INTO files_chunk_cache(collection_id,chunk_id,state,stored_bytes) VALUES($1,$2,'evicted',0)", [c, evicted]);
    expect((await cache.evictionCandidates()).map(candidate => candidate.chunk_id)).toEqual([neverRead, twoHours, tenMinutes]);
    expect(await cache.residentBytes()).toBe(50);
    expect(await cache.isProtected(c, guarded)).toBe(true);
    expect(await cache.isProtected(c, twoHours)).toBe(false);
  });

  it('moves a chunk resident → evicting → evicted only once, and hydration makes it resident again', async() => {
    // risk: data loss — two eviction passes must not both delete, and an evicted row must record zero local bytes.
    const c = await f.collection(); const id = ChunkSchemaFixture.chunkId();
    await cache.upsertResident(c, id, 300);
    expect(await cache.beginEviction(c, id)).toBe(true);
    expect(await cache.beginEviction(c, id)).toBe(false);
    await cache.completeEviction(c, id);
    expect(await row(c, id)).toMatchObject({ state: 'evicted', stored_bytes: '0' });
    expect((await row(c, id)).evicted_at).not.toBeNull();
    await cache.completeEviction(c, id); // only an evicting row completes
    await cache.markHydrated(c, id, 320);
    expect(await cache.state(c, id)).toBe('resident');
    expect(await row(c, id)).toMatchObject({ stored_bytes: '320' });
    expect(await cache.lastReadAt(c, id)).not.toBeNull();
  });

  it('records access without reviving an evicted chunk, and a local write clears its eviction', async() => {
    // risk: data integrity — a read stamp must not claim an evicted blob is on disk.
    const c = await f.collection(); const evicted = ChunkSchemaFixture.chunkId(); const fresh = ChunkSchemaFixture.chunkId();
    await f.pool.query("INSERT INTO files_chunk_cache(collection_id,chunk_id,state,stored_bytes,evicted_at) VALUES($1,$2,'evicted',0,NOW())", [c, evicted]);
    await cache.recordAccess([{ collectionId: c, chunkId: evicted }, { collectionId: c, chunkId: fresh }]);
    expect(await cache.state(c, evicted)).toBe('evicted');
    expect(await cache.state(c, fresh)).toBe('resident');
    await cache.upsertResident(c, evicted, 77);
    expect(await row(c, evicted)).toMatchObject({ state: 'resident', stored_bytes: '77', evicted_at: null });
  });

  it('settles interrupted evictions by whether the blob survived', async() => {
    // risk: data availability — a crash mid-eviction must not leave chunks stuck or claim deleted bytes.
    const c = await f.collection(); const kept = ChunkSchemaFixture.chunkId(); const gone = ChunkSchemaFixture.chunkId();
    await cache.upsertResident(c, kept, 40); await cache.upsertResident(c, gone, 50);
    await cache.beginEviction(c, kept); await cache.beginEviction(c, gone);
    expect((await cache.interruptedEvictions()).map(entry => entry.chunk_id).sort()).toEqual([kept, gone].sort());
    await cache.settleInterrupted(c, kept, 'resident'); await cache.settleInterrupted(c, gone, 'evicted');
    expect(await row(c, kept)).toMatchObject({ state: 'resident', stored_bytes: '40' });
    expect(await row(c, gone)).toMatchObject({ state: 'evicted', stored_bytes: '0' });
    expect(await cache.interruptedEvictions()).toEqual([]);
  });

  it('evicts the oldest unpinned verified chunk and stops once the requested bytes are freed', async() => {
    // risk: data loss — a pinned collection or a chunk without a verified cloud copy must never lose its only local blob.
    const pinned = await f.collection({ keepOnComputer: true }); const open = await f.collection();
    const [pinnedOld, oldest, older, unverified] = Array.from({ length: 4 }, () => ChunkSchemaFixture.chunkId());
    const blob = Buffer.alloc(64, 1);
    for (const [collectionId, id] of [[pinned, pinnedOld], [open, oldest], [open, older], [open, unverified]] as const) await store.put(collectionId, id, blob);
    await resident(pinned, pinnedOld, 64, '5 hours');
    await resident(open, unverified, 64, '4 hours');
    await resident(open, oldest, 64, '3 hours');
    await resident(open, older, 64, '2 hours');
    const source = {
      verifiedCopy: async(_collectionId:string, id:string) => id === unverified ? null : { cloudChunkId: id, cipherSha256: 'x', cipherBytes: 64, verifiedAt: new Date() },
      reverify: async() => true,
      fetchPlain: async() => { throw new Error('not used') },
    };
    const freed = await new ChunkCacheEvictor(cache, store, root, source).run(64);
    expect(freed).toBe(64);
    expect(await cache.state(open, oldest)).toBe('evicted');
    expect(await store.has(open, oldest)).toBe(false);
    for (const [collectionId, id] of [[pinned, pinnedOld], [open, unverified], [open, older]] as const) {
      expect(await cache.state(collectionId, id)).toBe('resident');
      expect(await store.has(collectionId, id)).toBe(true);
    }
    expect(await cache.collectionPin(pinned)).toEqual({ keep_on_computer: true });
    expect(await cache.collectionPin('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });
});
