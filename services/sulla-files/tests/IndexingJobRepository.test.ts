// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// The indexing queue's SQL against real Postgres with every Files migration (and trigger) applied.
// Point SULLA_FILES_TEST_DATABASE_URL at a throwaway database; the spec creates and drops its own schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IndexingAccountingRepository } from '../src/Repositories/IndexingAccountingRepository.js';
import { IndexingJobRepository } from '../src/Repositories/IndexingJobRepository.js';
import { SearchContentRepository } from '../src/Repositories/SearchContentRepository.js';
import { databaseUrl, SearchIndexDatabase } from './SearchIndexDatabase.js';

describe.skipIf(!databaseUrl)('indexing job, accounting and search content repositories (real Postgres)', () => {
  const database = new SearchIndexDatabase(databaseUrl ?? '');
  let jobs:IndexingJobRepository;
  let content:SearchContentRepository;
  let collectionId = '';

  beforeAll(async() => {
    await database.create();
    jobs = new IndexingJobRepository(database.pool);
    content = new SearchContentRepository(database.pool);
  });
  afterAll(async() => { await database.drop() });
  beforeEach(async() => {
    await database.pool.query('DELETE FROM file_index_jobs');
    collectionId = await database.collection();
  });

  // risk: lost or duplicated work — a claim must take the oldest due jobs, count the attempt and mark the file.
  it('claims the oldest due pending jobs in order, counts the attempt, marks the file and skips jobs that are not due', async() => {
    const later = await database.file(collectionId, 'later.txt');
    const first = await database.file(collectionId, 'first.txt');
    const notDue = await database.file(collectionId, 'not-due.txt');
    await database.pool.query("UPDATE file_index_jobs SET created_at=NOW()-INTERVAL '1 hour' WHERE version_id=$1", [first.versionId]);
    await database.pool.query("UPDATE file_index_jobs SET created_at=NOW()-INTERVAL '2 hours',available_at=NOW()+INTERVAL '1 hour' WHERE version_id=$1", [notDue.versionId]);

    expect(await jobs.claimBatch(1)).toEqual([{ file_id: first.fileId, version_id: first.versionId, attempts: 1 }]);
    expect((await database.job(first.versionId)).status).toBe('indexing');
    expect((await database.fileRow(first.fileId)).extraction_status).toBe('indexing');
    expect((await database.fileRow(later.fileId)).extraction_status).not.toBe('indexing');
    expect((await jobs.claimBatch(5)).map(job => job.version_id)).toEqual([later.versionId]);
    expect(await jobs.claimBatch(5)).toEqual([]);
    expect((await database.job(notDue.versionId)).status).toBe('pending');
  });

  // risk: deadlock (40P01) — the claim locks each file row before its job, the same order as lockEligibility.
  // A commit holding a file row must make the claim skip that job, not wait on it while holding a job lock.
  it('skips a job whose file row another transaction holds, without waiting on it', async() => {
    const held = await database.file(collectionId, 'held.txt');
    const free = await database.file(collectionId, 'free.txt');
    await database.pool.query("UPDATE file_index_jobs SET created_at=NOW()-INTERVAL '1 hour' WHERE version_id=$1", [held.versionId]);
    const holder = await database.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [held.fileId]);
      expect((await jobs.claimBatch(5)).map(job => job.version_id)).toEqual([free.versionId]);
      expect((await database.job(held.versionId)).status).toBe('pending');
      await holder.query('ROLLBACK');
    } finally { holder.release() }
  });

  // risk: two workers index the same version — SKIP LOCKED must hand a concurrent claimer different jobs.
  it('never hands a job another transaction is claiming to a second worker', async() => {
    const a = await database.file(collectionId, 'a.txt');
    const b = await database.file(collectionId, 'b.txt');
    const holder = await database.pool.connect();
    try {
      await holder.query('BEGIN');
      const held = await jobs.on(holder).claimBatch(1);
      const other = await jobs.claimBatch(5);
      expect(held).toHaveLength(1); expect(other).toHaveLength(1);
      expect([held[0].version_id, other[0].version_id].sort()).toEqual([a.versionId, b.versionId].sort());
      await holder.query('ROLLBACK');
    } finally { holder.release() }
  });

  // risk: indexing protected or deleted content — eligibility must report protection and deletion.
  it('reports eligibility under the row locks, including protection and system area', async() => {
    const file = await database.file(collectionId, 'notes.md', { mime: 'text/markdown' });
    const logs = await database.collection('logs');
    const logged = await database.file(logs, 'app.log');
    await database.pool.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [file.fileId]);
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const eligibility = await jobs.on(client).lockEligibility(file.fileId);
      expect(eligibility).toMatchObject({ id: file.fileId, collection_id: collectionId, path: 'notes.md', mime: 'text/markdown', current_version_id: file.versionId, deleted_at: null, system_area: null, protected: true });
      expect((await jobs.on(client).lockEligibility(logged.fileId))?.system_area).toBe('logs');
      expect(await jobs.on(client).lockEligibility('00000000-0000-4000-8000-000000000000')).toBeUndefined();
      await client.query('COMMIT');
    } finally { client.release() }
    // The unlocked batch read reports the same eligibility (it only decides what to extract).
    const read = await jobs.readEligibility([file.fileId, logged.fileId, '00000000-0000-4000-8000-000000000000']);
    expect(read.get(file.fileId)).toMatchObject({ path: 'notes.md', current_version_id: file.versionId, protected: true, system_area: null });
    expect(read.get(logged.fileId)?.system_area).toBe('logs');
    expect(read.size).toBe(2);
  });

  // risk: a manual re-index that keeps stale attempts/chunks never retries or serves old text.
  it('requeues a manual retry from zero attempts and clears only that version\'s derived text', async() => {
    const file = await database.file(collectionId, 'retry.txt');
    await database.chunk(file.fileId, file.versionId, 0, 'old chunk');
    await database.pool.query("UPDATE file_index_jobs SET status='failed',attempts=3,last_error='boom' WHERE version_id=$1", [file.versionId]);
    await database.pool.query("UPDATE file_search_text SET search_text='old text' WHERE file_id=$1", [file.fileId]);

    await jobs.requeueManually(file.fileId, file.versionId);

    expect(await database.job(file.versionId)).toMatchObject({ status: 'pending', attempts: 0, last_error: null, reason_code: 'manual_retry', finished_at: null });
    expect((await database.pool.query('SELECT count(*)::int n FROM file_search_chunks WHERE file_id=$1', [file.fileId])).rows[0].n).toBe(0);
    expect((await database.pool.query('SELECT search_text FROM file_search_text WHERE file_id=$1', [file.fileId])).rows[0].search_text).toBeNull();
    expect(await database.fileRow(file.fileId)).toMatchObject({ extraction_status: 'pending', extraction_reason_code: 'manual_retry', extracted_at: null });
  });

  // risk: a slow worker overwrites a newer claim — the attempt count fences the failure write.
  it('reschedules a failed job only while the worker still owns that attempt', async() => {
    const file = await database.file(collectionId, 'owned.txt');
    const [claimed] = await jobs.claimBatch(1);
    const outcome = { status: 'pending', reasonCode: 'retry_scheduled', reason: 'retry' };
    expect(await jobs.rescheduleOwnedJob({ ...claimed, attempts: claimed.attempts + 1 }, outcome, 'err')).toBe(false);
    expect((await database.job(file.versionId)).status).toBe('indexing');
    expect(await jobs.rescheduleOwnedJob(claimed, outcome, 'Local indexing operation failed')).toBe(true);
    const job = await database.job(file.versionId);
    expect(job).toMatchObject({ status: 'pending', last_error: 'Local indexing operation failed', reason_code: 'retry_scheduled', finished_at: null });
    expect(new Date(job.available_at).getTime()).toBeGreaterThan(Date.now() - 1_000);

    await jobs.markFileRetry(file.fileId, file.versionId, { status: 'failed', reasonCode: 'retry_exhausted', reason: 'gave up' });
    expect(await database.fileRow(file.fileId)).toMatchObject({ extraction_status: 'failed', extraction_reason_code: 'retry_exhausted' });
    expect((await database.fileRow(file.fileId)).extracted_at).not.toBeNull();
  });

  // risk: superseded versions keep serving search results, or a discard deletes the new version's chunks.
  it('discards a stale version without touching the current version\'s chunks or job', async() => {
    const file = await database.file(collectionId, 'versions.txt');
    const oldVersion = file.versionId;
    const current = await database.version(file.fileId, collectionId);
    await database.chunk(file.fileId, oldVersion, 0, 'old');
    await database.chunk(file.fileId, current, 0, 'current');
    await database.pool.query("INSERT INTO file_index_jobs(file_id,version_id,status) VALUES($1,$2,'indexing') ON CONFLICT DO NOTHING", [file.fileId, oldVersion]);

    await jobs.discardStale(file.fileId, oldVersion);

    expect(await database.job(oldVersion)).toBeUndefined();
    expect(await database.job(current)).toBeDefined();
    expect((await database.pool.query('SELECT content FROM file_search_chunks WHERE file_id=$1', [file.fileId])).rows.map(row => row.content)).toEqual(['current']);

    await jobs.discardIneligible(file.fileId, current);
    expect(await database.job(current)).toBeUndefined();
    expect((await database.pool.query('SELECT count(*)::int n FROM file_search_chunks WHERE file_id=$1', [file.fileId])).rows[0].n).toBe(0);
    expect((await database.pool.query('SELECT count(*)::int n FROM file_search_text WHERE file_id=$1', [file.fileId])).rows[0].n).toBe(0);
  });

  // risk: search shows a mix of versions — writing content replaces every version's chunks with the new ones.
  it('writes chunks, search text and the completed outcome for the current version', async() => {
    const file = await database.file(collectionId, 'doc.txt');
    const oldChunkVersion = file.versionId;
    const versionId = await database.version(file.fileId, collectionId);
    await database.chunk(file.fileId, oldChunkVersion, 0, 'previous content');

    await content.deleteChunksForFile(file.fileId);
    const chunkId = await content.insertChunk(file.fileId, versionId, 0, 'fresh alpha content', JSON.stringify([0.5, 0.5]));
    await content.upsertText(file.fileId, 'doc.txt', 'fresh alpha content');
    await jobs.complete(file.fileId, versionId, { status: 'indexed', reasonCode: 'text_extracted', reason: 'Text indexed locally.' });

    const chunks = (await database.pool.query('SELECT id,version_id,content,embedding_json FROM file_search_chunks WHERE file_id=$1', [file.fileId])).rows;
    expect(chunks).toEqual([{ id: chunkId, version_id: versionId, content: 'fresh alpha content', embedding_json: [0.5, 0.5] }]);
    expect((await database.pool.query('SELECT path,search_text FROM file_search_text WHERE file_id=$1', [file.fileId])).rows[0]).toEqual({ path: 'doc.txt', search_text: 'fresh alpha content' });
    expect(await database.job(versionId)).toMatchObject({ status: 'indexed', reason_code: 'text_extracted', last_error: null });
    expect(await database.fileRow(file.fileId)).toMatchObject({ extraction_status: 'indexed', extraction_reason_code: 'text_extracted' });
  });

  // risk: a crash mid-index leaves files stuck "indexing" forever, or protected files keep a job.
  it('reconciles interrupted, invalid and missing indexing bookkeeping at startup', async() => {
    const accounting = new IndexingAccountingRepository(database.pool);
    const interrupted = await database.file(collectionId, 'interrupted.txt');
    await database.pool.query("UPDATE file_index_jobs SET status='indexing',attempts=1 WHERE version_id=$1", [interrupted.versionId]);
    await database.pool.query("UPDATE files SET extraction_status='indexing' WHERE id=$1", [interrupted.fileId]);
    const missing = await database.file(collectionId, 'missing-job.txt');
    await database.pool.query('DELETE FROM file_index_jobs WHERE version_id=$1', [missing.versionId]);
    const invalid = await database.file(collectionId, 'invalid.txt');
    await database.pool.query("UPDATE files SET extraction_status='bogus' WHERE id=$1", [invalid.fileId]);
    const stale = await database.file(collectionId, 'stale.txt');
    const staleVersion = stale.versionId; await database.version(stale.fileId, collectionId);
    await database.pool.query("INSERT INTO file_index_jobs(file_id,version_id,status) VALUES($1,$2,'pending') ON CONFLICT DO NOTHING", [stale.fileId, staleVersion]);

    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await accounting.on(client).reconcile(['logs']);
      await client.query('COMMIT');
    } finally { client.release() }

    expect(await database.job(interrupted.versionId)).toMatchObject({ status: 'pending', reason_code: 'interrupted' });
    expect(await database.fileRow(interrupted.fileId)).toMatchObject({ extraction_status: 'pending', extraction_reason_code: 'interrupted' });
    expect(await database.job(missing.versionId)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await database.fileRow(invalid.fileId)).toMatchObject({ extraction_status: 'failed', extraction_reason_code: 'accounting_repaired' });
    expect(await database.job(invalid.versionId)).toMatchObject({ status: 'failed', reason_code: 'accounting_repaired' });
    expect(await database.job(staleVersion)).toBeUndefined();
  });
});
