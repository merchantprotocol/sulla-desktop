// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Real Postgres: the repair queries behind ChunkMetadataReconciler (migration 066 integrity).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChunkMetadataRepairRepository } from '../src/Repositories/ChunkMetadataRepairRepository.js';
import { ChunkSchemaFixture } from './ChunkSchemaFixture.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('chunk metadata repair queries (real Postgres)', () => {
  const f = new ChunkSchemaFixture(databaseUrl ?? '');
  const repairs = new ChunkMetadataRepairRepository(f.pool);

  beforeAll(async() => { await f.create() });
  afterAll(async() => { await f.drop() });
  beforeEach(async() => { await f.reset() });

  /** Versions whose chunk rows are missing can only exist with the 066 guard disabled (the pre-066 bug). */
  async function brokenFile(collectionId:string, manifestHash:string, size:number) {
    await f.pool.query('ALTER TABLE file_versions DISABLE TRIGGER files_guard_version_chunks');
    try { return await f.file(collectionId, manifestHash, size) } finally { await f.pool.query('ALTER TABLE file_versions ENABLE TRIGGER files_guard_version_chunks') }
  }

  it('lists only manifest chunks with no row, with their position and the manifest geometry', async() => {
    // risk: data loss — repair must find every unreadable chunk and none that are fine.
    const c = await f.collection();
    const [present, lostFirst, lostLast] = Array.from({ length: 3 }, () => ChunkSchemaFixture.chunkId());
    await f.chunk(c, present);
    const manifest = await f.manifest([lostFirst, present, lostLast], 2 * 4 * 1024 * 1024 + 9);
    await brokenFile(c, manifest, 2 * 4 * 1024 * 1024 + 9);
    await brokenFile(c, manifest, 2 * 4 * 1024 * 1024 + 9); // a second version of the same manifest is one reference row
    const missing = await repairs.missingReferences();
    expect(missing.map(row => ({ id: row.id, position: row.position, count: row.chunk_count, total: Number(row.total_size), collection: row.collection_id })).sort((a, b) => a.position - b.position))
      .toEqual([
        { id: lostFirst, position: 1, count: 3, total: 2 * 4 * 1024 * 1024 + 9, collection: c },
        { id: lostLast, position: 3, count: 3, total: 2 * 4 * 1024 * 1024 + 9, collection: c },
      ]);
  });

  it('restores a row with refcount equal to the distinct versions that reference it, exactly once', async() => {
    // risk: data integrity — a wrong refcount lets GC delete content still held by a version.
    const c = await f.collection(); const other = await f.collection(); const id = ChunkSchemaFixture.chunkId();
    const manifest = await f.manifest([id], 10);
    await brokenFile(c, manifest, 10); await brokenFile(c, manifest, 10); await brokenFile(other, manifest, 10);
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await repairs.lockVersions(client);
      expect(await repairs.chunkExists(client, c, id)).toBe(false);
      const refs = await repairs.versionReferenceCount(client, c, id);
      expect(refs).toBe(2);
      const row = { collectionId: c, id, size: 10, storedSize: 120, location: `chunks/${ c }/${ id }`, refcount: refs };
      expect(await repairs.insertRestored(client, row)).toBe(true);
      expect(await repairs.insertRestored(client, row)).toBe(false);
      expect(await repairs.chunkExists(client, c, id)).toBe(true);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    expect((await f.pool.query('SELECT size,stored_size,refcount FROM chunks WHERE collection_id=$1 AND id=$2', [c, id])).rows[0]).toEqual({ size: 10, stored_size: 120, refcount: '2' });
    expect((await repairs.missingReferences()).map(row => row.collection_id)).toEqual([other]);
  });
});
