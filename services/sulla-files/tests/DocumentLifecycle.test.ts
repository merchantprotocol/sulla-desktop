// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real-Postgres characterization of document publication, checkout/records rules and chunk GC.
// Point SULLA_FILES_TEST_DATABASE_URL at a throwaway Postgres, e.g.
//   docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine
// Each run creates and drops its own schema and applies the real 001/024/035 migrations
// (their version-numbering and lifecycle triggers are part of what is being exercised).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TransactionRunner } from '../src/FilesTransaction.js';
import { ChunkGcRepository } from '../src/Repositories/ChunkGcRepository.js';
import { DocumentLifecycleRepository } from '../src/Repositories/DocumentLifecycleRepository.js';
import { ChunkGcDrainer } from '../src/Services/ChunkGcDrainer.js';
import { DocumentPublicationService } from '../src/Services/DocumentPublicationService.js';
import { LifecycleRecordsService } from '../src/Services/LifecycleRecordsService.js';
import type { FilesIdentity } from '../src/auth.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
// gen_random_uuid() is built in on Postgres 13+; skip the extension so nothing lands outside the schema.
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8').replace(/CREATE EXTENSION[^;]*;/g, '');
const human:FilesIdentity = { userId: 'human-1', deviceId: 'device-1', kind: 'capability' };
const otherHuman:FilesIdentity = { userId: 'human-2', deviceId: 'device-2', kind: 'capability' };
const agent:FilesIdentity = { userId: 'human-1', deviceId: 'device-1', kind: 'capability', agentId: 'agent-1', jobId: 'job-1' };

describe.skipIf(!databaseUrl)('document lifecycle (real Postgres)', () => {
  const schema = `files_lifecycle_spec_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${ schema }`, max: 4 });
  const lifecycle = new DocumentLifecycleRepository(pool);
  const transactions = new TransactionRunner(pool);
  const publication = new DocumentPublicationService(lifecycle, transactions);
  const records = new LifecycleRecordsService(lifecycle, transactions);
  let collectionId = '';

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA ${ schema }`);
    for (const name of ['001_sulla_files.sql', '024_document_lifecycle.sql', '035_files_publish_requests.sql']) await pool.query(migration(name));
  });
  afterAll(async() => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await admin.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE files_publish_requests, file_chunk_gc, audit_log, journal, chunks, manifests, file_versions, files, collections CASCADE');
    collectionId = (await pool.query(`INSERT INTO collections(owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext)
      VALUES('human-1','Docs','knowledge','desktop-only','{}','{}') RETURNING id`)).rows[0].id;
  });

  async function addVersion(fileId:string, by:'user' | 'agent-run', manifestHash:string | null = null):Promise<string> {
    const id = (await pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,1,$4,$5,'device-1') RETURNING id`, [fileId, collectionId, manifestHash, by, by === 'user' ? 'human-1' : 'agent-1'])).rows[0].id;
    await pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, id]);
    return id;
  }
  /** A file with a published human version v1 and an agent draft v2. */
  async function document() {
    const fileId = (await pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id) VALUES($1,$2,'user','human-1') RETURNING id`, [collectionId, `doc-${ randomUUID() }.md`])).rows[0].id as string;
    const v1 = await addVersion(fileId, 'user'); const v2 = await addVersion(fileId, 'agent-run');
    return { fileId, v1, v2 };
  }
  const version = async(id:string) => (await pool.query('SELECT * FROM file_versions WHERE id=$1', [id])).rows[0];
  const file = async(id:string) => (await pool.query('SELECT * FROM files WHERE id=$1', [id])).rows[0];

  // risk: data accuracy — publishing must supersede the old version, renumber the new one and journal it once.
  it('publishes a draft as the next major version and supersedes the previous one', async() => {
    const { fileId, v1, v2 } = await document();
    expect((await version(v2)).publication_status).toBe('draft');
    const before = await file(fileId); const priorMajor = Number((await version(v2)).major_version);
    const published = await publication.publish(fileId, human, { comment: 'ship it' });
    expect(published).toMatchObject({ published_version_id: v2, draft_version_id: null });
    expect(Number(published.lifecycle_generation)).toBeGreaterThan(Number(before.lifecycle_generation));
    expect(await version(v2)).toMatchObject({ publication_status: 'published', version_kind: 'major', major_version: priorMajor + 1, minor_version: 0, published_by: 'human-1', version_comment: 'ship it' });
    expect((await version(v1)).publication_status).toBe('superseded');
    expect((await pool.query("SELECT version_id FROM journal WHERE file_id=$1 AND op='put'", [fileId])).rows).toEqual([{ version_id: v2 }]);
    // Publishing an already-published version is a no-op.
    await publication.publish(fileId, human, { explicitVersionId: v2 });
    expect((await pool.query("SELECT count(*)::int n FROM journal WHERE file_id=$1 AND op='put'", [fileId])).rows[0].n).toBe(1);
  });

  // risk: permissions — agents can never publish; a stale or retained file can never be published.
  it('refuses agent, stale-draft and retention-locked publication without changing the draft', async() => {
    const { fileId, v2 } = await document();
    await expect(publication.publish(fileId, agent, {})).rejects.toMatchObject({ status: 403 });
    await expect(publication.publish(fileId, human, { requireExpectedDraft: true, expectedDraftVersionId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await pool.query("UPDATE files SET retention_mode='retain-until',retain_until=NOW()+interval '1 day' WHERE id=$1", [fileId]);
    await expect(publication.publish(fileId, human, {})).rejects.toMatchObject({ status: 423 });
    expect((await version(v2)).publication_status).toBe('draft');
    expect((await file(fileId)).draft_version_id).toBe(v2);
  });

  // risk: permissions + business rule — agent requests are idempotent while pending and only a human decides them once.
  it('records one pending publish request per draft and lets a human approve it once', async() => {
    const { fileId, v2 } = await document();
    await expect(publication.requestPublication(fileId, v2, human, null)).rejects.toMatchObject({ status: 403 });
    const first = await publication.requestPublication(fileId, v2, agent, 'please review');
    const again = await publication.requestPublication(fileId, v2, agent, null);
    expect(again).toMatchObject({ id: first.id, status: 'pending', requested_by: 'job-1', reason: 'please review' });
    expect((await publication.listRequests('pending', fileId)).map(row => row.id)).toEqual([first.id]);
    await expect(publication.listRequests('bogus', null)).rejects.toMatchObject({ status: 400 });
    let resolvedFile = '';
    const decided = await publication.decide(first.id, 'approve', human, null, id => { resolvedFile = id });
    expect(resolvedFile).toBe(fileId);
    expect(decided.request).toMatchObject({ status: 'approved', decided_by: 'human-1' });
    expect(decided.file.published_version_id).toBe(v2);
    expect((await version(v2)).publication_status).toBe('published');
    await expect(publication.decide(first.id, 'reject', human, null)).rejects.toMatchObject({ status: 409 });
  });

  // risk: data accuracy — a rejected request leaves the draft unpublished.
  it('rejects a publish request without publishing', async() => {
    const { fileId, v2 } = await document();
    const request = await publication.requestPublication(fileId, v2, agent, null);
    const decided = await publication.decide(request.id, 'reject', human, null);
    expect(decided.request.status).toBe('rejected');
    expect((await version(v2)).publication_status).toBe('draft');
  });

  // risk: data accuracy — check-in numbers a draft as the next minor of its major and releases the checkout.
  it('checks a draft in as the next minor version and releases the checkout', async() => {
    const { fileId, v2 } = await document();
    await records.checkout(fileId, human);
    await expect(records.checkout(fileId, otherHuman)).rejects.toMatchObject({ status: 409 });
    await expect(records.releaseCheckout(fileId, otherHuman, false)).rejects.toMatchObject({ status: 409 });
    const major = Number((await version(v2)).major_version);
    const row = await publication.checkin(fileId, human, { kind: 'minor', comment: 'wip' });
    expect(row.checked_out_by_user_id).toBeNull();
    expect(await version(v2)).toMatchObject({ version_kind: 'minor', major_version: major, minor_version: 1, version_comment: 'wip', publication_status: 'draft' });
    await expect(publication.checkin(fileId, human, { versionId: randomUUID() })).rejects.toMatchObject({ status: 404 });
  });

  // risk: compliance — a policy record can't be downgraded, unlocked or have its retention shortened.
  it('protects policy records from downgrade, unlock and shortened retention', async() => {
    const { fileId } = await document();
    const tenDays = new Date(Date.now() + 10 * 86_400_000);
    await records.updateRetention(fileId, records.parseRetention({ mode: 'retain-until', retainUntil: tenDays.toISOString() }));
    await records.lockRecord(fileId, human, 'policy');
    await expect(records.lockRecord(fileId, human, 'ordinary')).rejects.toMatchObject({ status: 423 });
    await expect(records.unlockRecord(fileId)).rejects.toMatchObject({ status: 423 });
    await expect(records.updateRetention(fileId, records.parseRetention({ mode: 'retain-until', retainUntil: new Date(Date.now() + 86_400_000).toISOString() }))).rejects.toMatchObject({ status: 423 });
    await expect(records.updateSettings(fileId, { enabled: false })).rejects.toMatchObject({ status: 423 });
    expect(await file(fileId)).toMatchObject({ record_lock_type: 'policy', retention_mode: 'retain-until', versioning_enabled: true });
    expect(new Date((await file(fileId)).retain_until).getTime()).toBe(tenDays.getTime());
  });

  // risk: data loss — chunk GC deletes only chunks no version references, and keeps a chunk whose delete failed.
  it('drains the chunk GC queue, deleting only unreferenced chunks', async() => {
    const { fileId } = await document();
    await pool.query(`INSERT INTO manifests(hash,chunk_ids,total_size) VALUES('m1','["kept"]',1)`);
    await addVersion(fileId, 'user', 'm1');
    for (const id of ['kept', 'orphan', 'stuck']) await pool.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location) VALUES($1,$2,1,1,'local')`, [collectionId, id]);
    const auditId = (await pool.query(`INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user','human-1','disposal-purge','{"physicalChunkGc":"pending"}') RETURNING id`)).rows[0].id;
    const gc = new ChunkGcRepository(pool);
    for (const id of ['kept', 'orphan']) await gc.queue(pool, collectionId, id, auditId);
    await gc.queue(pool, collectionId, 'stuck', null);
    const deleted:string[] = [];
    await new ChunkGcDrainer(pool).drain(async(_collection, chunkId) => { if (chunkId === 'stuck') throw new Error('disk busy'); deleted.push(chunkId) });
    expect(deleted).toEqual(['orphan']);
    const chunks = (await pool.query('SELECT id,refcount FROM chunks ORDER BY id')).rows;
    // 'stuck' rolled back with its failed delete: row kept, refcount untouched, error recorded.
    expect(chunks).toEqual([{ id: 'kept', refcount: '1' }, { id: 'stuck', refcount: '0' }]);
    expect((await pool.query('SELECT chunk_id,last_error FROM file_chunk_gc')).rows).toEqual([{ chunk_id: 'stuck', last_error: 'disk busy' }]);
    expect((await pool.query('SELECT details FROM audit_log WHERE id=$1', [auditId])).rows[0].details.physicalChunkGc).toBe('complete');
  });
});
