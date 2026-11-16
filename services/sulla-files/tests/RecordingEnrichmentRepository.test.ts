// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Recording enrichment queue and transcript persistence against real Postgres with every Files
// migration applied. Point SULLA_FILES_TEST_DATABASE_URL at a throwaway database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RecordingEnrichmentJobRepository } from '../src/Repositories/RecordingEnrichmentJobRepository.js';
import { RecordingEnrichmentWriter } from '../src/Services/RecordingEnrichmentWriter.js';
import { databaseUrl, SearchIndexDatabase, type SeededFile } from './SearchIndexDatabase.js';

describe.skipIf(!databaseUrl)('recording enrichment repositories (real Postgres)', () => {
  const database = new SearchIndexDatabase(databaseUrl ?? '');
  let jobs:RecordingEnrichmentJobRepository;
  let writer:RecordingEnrichmentWriter;
  let collectionId = '';

  beforeAll(async() => {
    await database.create();
    jobs = new RecordingEnrichmentJobRepository(database.pool);
    writer = RecordingEnrichmentWriter.forPool(database.pool);
  });
  afterAll(async() => { await database.drop() });
  beforeEach(async() => {
    await database.pool.query('DELETE FROM recording_enrichment_jobs');
    collectionId = await database.collection();
  });

  async function recording(path:string):Promise<SeededFile> {
    const file = await database.file(collectionId, path, { mime: 'video/webm' });
    await database.pool.query('INSERT INTO recording_enrichment_jobs(file_id,version_id) VALUES($1,$2)', [file.fileId, file.versionId]);
    return file;
  }
  const job = async(versionId:string) => (await database.pool.query('SELECT * FROM recording_enrichment_jobs WHERE version_id=$1', [versionId])).rows[0];
  const output = (file:SeededFile) => ({ fileId: file.fileId, versionId: file.versionId, language: 'en',
    transcript: [{ start: 0, end: 2, text: 'hello' }, { start: 2, end: 4, text: 'world' }], chapters: [{ start: 0, end: 4, title: 'hello world' }], duration: 4 });

  // risk: a recording transcribed twice or never — claim takes the oldest due job and counts the attempt.
  it('claims due jobs oldest first, and requeues interrupted and runtime-parked jobs', async() => {
    const second = await recording('second.webm');
    const first = await recording('first.webm');
    await database.pool.query("UPDATE recording_enrichment_jobs SET created_at=NOW()-INTERVAL '1 hour' WHERE version_id=$1", [first.versionId]);

    expect(await jobs.claimNext()).toEqual({ file_id: first.fileId, version_id: first.versionId, attempts: 1 });
    await jobs.parkWaitingForRuntime(first.versionId);
    expect(await job(first.versionId)).toMatchObject({ status: 'waiting_runtime', last_error: 'whisper.cpp model/runtime not installed' });
    expect((await jobs.claimNext())?.version_id).toBe(second.versionId);
    expect(await jobs.claimNext()).toBeUndefined();

    await jobs.requeueInterrupted();
    expect(await job(second.versionId)).toMatchObject({ status: 'pending', started_at: null });
    expect((await job(first.versionId)).status).toBe('waiting_runtime');
    await jobs.releaseWaitingForRuntime();
    expect((await job(first.versionId)).status).toBe('pending');
  });

  // risk: endless retries — a third failure is terminal, earlier ones retry after a delay.
  it('schedules a retry with a delay and marks a terminal failure finished', async() => {
    const file = await recording('retry.webm');
    await jobs.scheduleRetry(file.versionId, 'pending', 'decode failed');
    const retried = await job(file.versionId);
    expect(retried).toMatchObject({ status: 'pending', last_error: 'decode failed', finished_at: null });
    expect(new Date(retried.available_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await jobs.claimNext()).toBeUndefined();
    await jobs.scheduleRetry(file.versionId, 'failed', 'gave up');
    expect((await job(file.versionId)).finished_at).not.toBeNull();
    expect(await jobs.findFile(file.fileId)).toMatchObject({ id: file.fileId, path: 'retry.webm', current_version_id: file.versionId, deleted_at: null });
    await jobs.deleteJob(file.versionId);
    expect(await job(file.versionId)).toBeUndefined();
  });

  // risk: transcript lost — a current, eligible recording stores metadata, search text and completes.
  it('stores the transcript for the current version and makes it searchable', async() => {
    const file = await recording('meeting.webm');
    expect(await writer.persist(output(file))).toBe('stored');
    const metadata = (await database.pool.query('SELECT * FROM recording_metadata WHERE file_id=$1', [file.fileId])).rows[0];
    expect(metadata).toMatchObject({ version_id: file.versionId, language: 'en', duration_seconds: 4, generator: 'whisper.cpp', chapters: [{ start: 0, end: 4, title: 'hello world' }] });
    expect(metadata.transcript).toHaveLength(2);
    expect((await database.pool.query('SELECT search_text FROM file_search_text WHERE file_id=$1', [file.fileId])).rows[0].search_text).toBe('hello world');
    expect((await database.fileRow(file.fileId)).extraction_status).toBe('indexed');
    expect((await job(file.versionId)).status).toBe('completed');
  });

  // risk: derived plaintext of a superseded version overwrites the current one.
  it('abandons a stale version without writing metadata', async() => {
    const file = await recording('edited.webm');
    await database.version(file.fileId, collectionId);
    await database.pool.query('INSERT INTO recording_enrichment_jobs(file_id,version_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [file.fileId, file.versionId]);
    expect(await writer.persist(output(file))).toBe('abandoned-stale');
    expect(await job(file.versionId)).toBeUndefined();
    expect((await database.pool.query('SELECT count(*)::int n FROM recording_metadata WHERE file_id=$1', [file.fileId])).rows[0].n).toBe(0);
  });

  // risk: privacy — a transcript of a file protected mid-transcription must never be stored.
  it('purges every derived row when the recording became protected', async() => {
    const file = await recording('private.webm');
    await database.pool.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [file.fileId]);
    await database.pool.query('INSERT INTO recording_enrichment_jobs(file_id,version_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [file.fileId, file.versionId]);
    expect(await writer.persist(output(file))).toBe('abandoned-ineligible');
    for (const table of ['recording_metadata', 'recording_enrichment_jobs', 'file_index_jobs', 'file_search_chunks', 'file_search_text']) {
      expect((await database.pool.query(`SELECT count(*)::int n FROM ${ table } WHERE file_id=$1`, [file.fileId])).rows[0].n, table).toBe(0);
    }
  });
});
