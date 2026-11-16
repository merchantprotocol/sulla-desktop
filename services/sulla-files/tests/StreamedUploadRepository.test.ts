// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Real Postgres: phase 2 of a streamed upload (metadata commit) and the chunk-registration guard.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ManifestChunkRegistry, UnregisteredChunkError } from '../src/ManifestChunkRegistry.js';
import { ChunkRegistryRepository } from '../src/Repositories/ChunkRegistryRepository.js';
import { StreamingUploadService, type StreamedUpload } from '../src/streamingUpload.js';
import { USE_CASE_PATH_PREFIX } from '../src/useCasePaths.js';
import { ChunkSchemaFixture } from './ChunkSchemaFixture.js';

import type pg from 'pg';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('streamed upload commit (real Postgres)', () => {
  const f = new ChunkSchemaFixture(databaseUrl ?? '');
  const service = new StreamingUploadService();
  const user = { userId: 'u1', deviceId: 'mac-1', kind: 'capability' as const };

  beforeAll(async() => { await f.create() });
  afterAll(async() => { await f.drop() });
  beforeEach(async() => { await f.reset() });

  function streamed(chunks:{ id:string; size:number; storedSize:number }[]):StreamedUpload {
    return { chunkIds: chunks.map(chunk => chunk.id), chunks, totalSize: chunks.reduce((sum, chunk) => sum + chunk.size, 0), sourceHash: 'source-hash' };
  }
  async function inTransaction<T>(work:(client:pg.PoolClient) => Promise<T>):Promise<T> {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  function input(collectionId:string, path:string, extra:Record<string, unknown> = {}) {
    return { uploadId: 'u', collectionId, path, mime: 'text/plain', actor: user, body: undefined as any, intentDb: f.pool, ...extra };
  }

  it('records the file, its current version, chunk refcounts, journal and audit in one commit', async() => {
    // risk: data integrity — a committed version must be readable: manifest, chunk rows and refcounts all present.
    const c = await f.collection(); const a = ChunkSchemaFixture.chunkId(); const b = ChunkSchemaFixture.chunkId();
    const upload = streamed([{ id: a, size: 4 * 1024 * 1024, storedSize: 900 }, { id: b, size: 5, storedSize: 120 }]);
    const file = await inTransaction(client => service.commit(client, input(c, 'docs/report.txt'), upload));
    expect(file).toMatchObject({ path: 'docs/report.txt', size: upload.totalSize, source_hash: 'source-hash' });
    const version = (await f.pool.query('SELECT * FROM file_versions WHERE id=$1', [file.current_version_id])).rows[0];
    expect(version).toMatchObject({ file_id: file.id, chunk_collection_id: c, parent_version_id: null, device_id: 'mac-1', publication_status: null, message: 'Imported into Files' });
    const manifest = (await f.pool.query('SELECT chunk_ids,total_size FROM manifests WHERE hash=$1', [version.manifest_hash])).rows[0];
    expect(manifest).toEqual({ chunk_ids: [a, b], total_size: String(upload.totalSize) });
    const chunks = (await f.pool.query('SELECT id,size,stored_size,location,refcount FROM chunks WHERE collection_id=$1 ORDER BY size DESC', [c])).rows;
    expect(chunks).toEqual([
      { id: a, size: 4 * 1024 * 1024, stored_size: 900, location: `chunks/${ c }/${ a }`, refcount: '1' },
      { id: b, size: 5, stored_size: 120, location: `chunks/${ c }/${ b }`, refcount: '1' },
    ]);
    expect((await f.pool.query("SELECT op FROM journal WHERE version_id=$1", [version.id])).rows).toEqual([{ op: 'put' }]);
    expect((await f.pool.query('SELECT who_type,who_id,action,details FROM audit_log WHERE version_id=$1', [version.id])).rows)
      .toEqual([{ who_type: 'user', who_id: 'u1', action: 'upload', details: { path: 'docs/report.txt' } }]);
  });

  it('replacing a file with identical content reuses the manifest and chunk rows and bumps refcounts', async() => {
    // risk: data integrity — dedup must keep refcounts equal to the number of versions holding the chunk.
    const c = await f.collection(); const a = ChunkSchemaFixture.chunkId();
    const upload = streamed([{ id: a, size: 7, storedSize: 140 }]);
    const first = await inTransaction(client => service.commit(client, input(c, 'notes.txt'), upload));
    const second = await inTransaction(client => service.commit(client, input(c, 'notes.txt', { existingFile: { id: first.id, current_version_id: first.current_version_id } }), upload));
    expect(second.id).toBe(first.id);
    expect((await f.pool.query('SELECT parent_version_id FROM file_versions WHERE id=$1', [second.current_version_id])).rows[0].parent_version_id).toBe(first.current_version_id);
    expect((await f.pool.query('SELECT current_version_id FROM files WHERE id=$1', [first.id])).rows[0].current_version_id).toBe(second.current_version_id);
    expect((await f.pool.query('SELECT refcount FROM chunks WHERE collection_id=$1 AND id=$2', [c, a])).rows[0].refcount).toBe('2');
  });

  it('rejects content whose existing chunk row disagrees, leaving nothing committed', async() => {
    // risk: data corruption — a version must never point at a chunk row describing different bytes.
    const c = await f.collection(); const a = ChunkSchemaFixture.chunkId();
    await f.chunk(c, a, 7, 999);
    await expect(inTransaction(client => service.commit(client, input(c, 'clash.txt'), streamed([{ id: a, size: 7, storedSize: 140 }]))))
      .rejects.toThrow('Existing chunk metadata does not match uploaded content');
    expect((await f.pool.query('SELECT count(*)::int n FROM files')).rows[0].n).toBe(0);
    expect((await f.pool.query('SELECT count(*)::int n FROM manifests')).rows[0].n).toBe(0);
  });

  it('an agent write to a use-case path is committed as a draft', async() => {
    // risk: publication policy — agent-authored use cases must not go live without approval.
    const c = await f.collection(); const path = `${ USE_CASE_PATH_PREFIX }skills/demo/SKILL.md`;
    const file = await inTransaction(client => service.commit(client, input(c, path, { actor: { ...user, agentId: 'agent-1', jobId: 'job-9' } }), streamed([{ id: ChunkSchemaFixture.chunkId(), size: 3, storedSize: 100 }])));
    const version = (await f.pool.query('SELECT publication_status,created_by_type,created_by_id FROM file_versions WHERE id=$1', [file.current_version_id])).rows[0];
    expect(version).toEqual({ publication_status: 'draft', created_by_type: 'agent-run', created_by_id: 'job-9' });
    expect((await f.pool.query('SELECT who_type,action FROM audit_log WHERE version_id=$1', [file.current_version_id])).rows).toEqual([{ who_type: 'agent-or-device', action: 'draft-write' }]);
  });

  it('the registration guard reports exactly the unregistered ids of this collection', async() => {
    // risk: data loss — a version naming a chunk with no row is listed but unreadable forever.
    const c = await f.collection(); const other = await f.collection();
    const [registered, foreign, missing] = Array.from({ length: 3 }, () => ChunkSchemaFixture.chunkId());
    await f.chunk(c, registered); await f.chunk(other, foreign);
    expect([...await new ChunkRegistryRepository().registeredIds(f.pool, c, [registered, foreign, missing])]).toEqual([registered]);
    const guard = new ManifestChunkRegistry();
    await expect(guard.assertRegistered(f.pool, c, [registered, registered])).resolves.toBeUndefined();
    const error = await guard.assertRegistered(f.pool, c, [registered, foreign, missing, missing]).catch(caught => caught);
    expect(error).toBeInstanceOf(UnregisteredChunkError);
    expect(error).toMatchObject({ code: 'FILES_CHUNK_UNREGISTERED', collectionId: c, missing: [foreign, missing] });
  });
});
