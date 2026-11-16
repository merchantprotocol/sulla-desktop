// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Real Postgres: upload intents and the startup cleanup that deletes orphan chunk blobs.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UploadIntentRepository } from '../src/Repositories/UploadIntentRepository.js';
import { StaleUploadCleaner, UploadIntentService } from '../src/uploadCleanup.js';
import { ChunkSchemaFixture } from './ChunkSchemaFixture.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('upload intents and stale upload cleanup (real Postgres)', () => {
  const f = new ChunkSchemaFixture(databaseUrl ?? '');
  const intents = new UploadIntentRepository(f.pool);

  beforeAll(async() => { await f.create() });
  afterAll(async() => { await f.drop() });
  beforeEach(async() => { await f.reset() });

  async function staleIntent(collectionId:string, chunkIds:string[], age = '2 hours'):Promise<string> {
    const id = randomUUID();
    await f.pool.query('INSERT INTO file_upload_intents(id,collection_id,chunk_ids,updated_at) VALUES($1,$2,$3,NOW()-$4::interval)', [id, collectionId, JSON.stringify(chunkIds), age]);
    return id;
  }
  function recordingStore() {
    const deleted:string[] = [];
    return { deleted, store: { delete: async(_collectionId:string, id:string) => { deleted.push(id) } } };
  }

  it('records each published chunk once and refuses to publish under a claimed intent', async() => {
    // risk: data loss — an upload resuming after cleanup claimed it must not publish a blob cleanup will delete.
    const c = await f.collection(); const uploadId = randomUUID(); const chunk = ChunkSchemaFixture.chunkId();
    const service = new UploadIntentService(intents);
    await service.begin(uploadId, c);
    let published = 0;
    await service.publishChunk(uploadId, chunk, async() => { published++ });
    await service.publishChunk(uploadId, chunk, async() => { published++ });
    expect((await f.pool.query('SELECT chunk_ids FROM file_upload_intents WHERE id=$1', [uploadId])).rows[0].chunk_ids).toEqual([chunk]);
    await f.pool.query("UPDATE file_upload_intents SET cleanup_started_at=NOW() WHERE id=$1", [uploadId]);
    await expect(service.publishChunk(uploadId, ChunkSchemaFixture.chunkId(), async() => { published++ })).rejects.toThrow('Upload cleanup intent is unavailable');
    expect(published).toBe(2);
    await service.complete(uploadId);
    expect((await f.pool.query('SELECT 1 FROM file_upload_intents WHERE id=$1', [uploadId])).rowCount).toBe(0);
  });

  it('claims only stale intents, and a claim is not offered again until it goes stale itself', async() => {
    // risk: data loss — cleanup must never claim a live upload.
    const c = await f.collection();
    const stale = await staleIntent(c, []);
    await staleIntent(c, [], '5 minutes');
    expect((await intents.claimStale('1 hour')).map(intent => intent.id)).toEqual([stale]);
    expect(await intents.claimStale('1 hour')).toEqual([]);
  });

  it('deletes only orphan blobs: registered, live and version-referenced chunks are kept', async() => {
    // risk: data loss — a blob a version's manifest names is user content even when its chunks row is missing.
    const c = await f.collection();
    const [orphan, registered, live, referenced] = Array.from({ length: 4 }, () => ChunkSchemaFixture.chunkId());
    await f.chunk(c, registered);
    await f.pool.query('INSERT INTO file_upload_intents(id,collection_id,chunk_ids) VALUES($1,$2,$3)', [randomUUID(), c, JSON.stringify([live])]);
    const manifest = await f.manifest([referenced], 10);
    await f.pool.query('ALTER TABLE file_versions DISABLE TRIGGER files_guard_version_chunks');
    try { await f.file(c, manifest, 10) } finally { await f.pool.query('ALTER TABLE file_versions ENABLE TRIGGER files_guard_version_chunks') }
    const intentId = await staleIntent(c, [orphan, registered, live, referenced, orphan]);

    expect(await intents.chunkState(c, registered, '1 hour')).toEqual({ registered: true, active: false });
    expect(await intents.chunkState(c, live, '1 hour')).toEqual({ registered: false, active: true });
    expect(await intents.referencedByVersion(c, referenced)).toBe(true);
    expect(await intents.referencedByVersion(c, orphan)).toBe(false);

    const { deleted, store } = recordingStore();
    const warnings:string[] = [];
    expect(await new StaleUploadCleaner(intents, store, { warn: message => warnings.push(message) }).run()).toBe(1);
    expect(deleted).toEqual([orphan]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(referenced);
    expect((await f.pool.query('SELECT 1 FROM file_upload_intents WHERE id=$1', [intentId])).rowCount).toBe(0);
  });

  it('scopes chunk checks to the intent collection', async() => {
    // risk: tenant isolation — a chunk registered in another collection does not protect this collection's orphan.
    const mine = await f.collection(); const other = await f.collection(); const id = ChunkSchemaFixture.chunkId();
    await f.chunk(other, id);
    await staleIntent(mine, [id]);
    const { deleted, store } = recordingStore();
    expect(await new StaleUploadCleaner(intents, store, { warn: () => undefined }).run()).toBe(1);
    expect(deleted).toEqual([id]);
  });
});
