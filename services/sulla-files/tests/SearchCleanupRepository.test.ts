// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Derived-row cleanup and the halfvec backfill bookkeeping against real Postgres with every
// Files migration applied. Point SULLA_FILES_TEST_DATABASE_URL at a throwaway database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SearchCleanupRepository } from '../src/Repositories/SearchCleanupRepository.js';
import { VectorBackfillRepository } from '../src/Repositories/VectorBackfillRepository.js';
import { VECTOR_READY_MARKER } from '../src/Repositories/VectorStateRepository.js';
import { SearchCleanupService } from '../src/Services/SearchCleanupService.js';
import { databaseUrl, SearchIndexDatabase } from './SearchIndexDatabase.js';

describe.skipIf(!databaseUrl)('search cleanup and vector backfill repositories (real Postgres)', () => {
  const database = new SearchIndexDatabase(databaseUrl ?? '');

  beforeAll(async() => { await database.create() });
  afterAll(async() => { await database.drop() });

  const count = async(sql:string, values:unknown[]) => (await database.pool.query(sql, values)).rows[0].n as number;

  // risk: data loss — cleanup must remove only superseded and logs-area derived rows, never current ones.
  it('deletes obsolete chunks, jobs and logs search text in batches and keeps current rows', async() => {
    const collectionId = await database.collection();
    const kept = await database.file(collectionId, 'kept.txt');
    await database.chunk(kept.fileId, kept.versionId, 0, 'current');
    const edited = await database.file(collectionId, 'edited.txt');
    const oldVersion = edited.versionId;
    const current = await database.version(edited.fileId, collectionId);
    await database.chunk(edited.fileId, oldVersion, 0, 'old a');
    await database.chunk(edited.fileId, oldVersion, 1, 'old b');
    await database.chunk(edited.fileId, current, 0, 'new');
    expect(await database.job(oldVersion)).toBeDefined();
    const logs = await database.collection('logs');
    const logged = await database.file(logs, 'app.log');
    await database.chunk(logged.fileId, logged.versionId, 0, 'log line');
    await database.pool.query('INSERT INTO file_search_text(file_id,path,search_text) VALUES($1,$2,$3) ON CONFLICT(file_id) DO UPDATE SET search_text=EXCLUDED.search_text', [logged.fileId, 'app.log', 'log line']);

    const repository = new SearchCleanupRepository(database.pool);
    expect(await repository.deleteObsoleteChunks(1)).toBe(1);
    let removed = 1;
    for (let rows = 1; rows;) { rows = await repository.deleteObsoleteChunks(1); removed += rows }
    expect(removed).toBe(3);
    expect(await repository.deleteLogsSearchText(10)).toBe(1);
    expect(await repository.deleteObsoleteJobs(10)).toBe(1);

    expect((await database.pool.query('SELECT content FROM file_search_chunks ORDER BY content')).rows.map(row => row.content)).toEqual(['current', 'new']);
    expect(await database.job(oldVersion)).toBeUndefined();
    expect(await database.job(current)).toBeDefined();
    expect(await database.job(kept.versionId)).toBeDefined();
    expect(await count('SELECT count(*)::int n FROM file_search_text WHERE file_id=$1', [kept.fileId])).toBe(1);
    expect(await count('SELECT count(*)::int n FROM file_search_text WHERE file_id=$1', [logged.fileId])).toBe(0);
  });

  // risk: two services clean up at once — the session advisory lock admits one runner at a time.
  it('admits one cleanup runner per lock and lets the service skip when another holds it', async() => {
    const first = await database.pool.connect(); const second = await database.pool.connect();
    try {
      const a = new SearchCleanupRepository(first); const b = new SearchCleanupRepository(second);
      expect(await a.tryLock(8_795_143)).toBe(true);
      expect(await b.tryLock(8_795_143)).toBe(false);
      const logged:string[] = [];
      await new SearchCleanupService(database.pool, { log: message => logged.push(message), pause: async() => undefined }).run();
      expect(logged).toEqual([]);
      await a.unlock(8_795_143);
      await new SearchCleanupService(database.pool, { log: message => logged.push(message), pause: async() => undefined }).run();
      expect(logged).toEqual(['[FilesSearchCleanup] complete (0 derived rows removed)']);
    } finally { first.release(); second.release() }
  });

  // risk: search switches to halfvec before every embedding was copied.
  it('tracks JSON-only chunks and the ready marker for the backfill', async() => {
    const session = await database.pool.connect();
    try {
      const backfill = new VectorBackfillRepository(session);
      const hasTable = await database.vectorsAvailable();
      expect(await backfill.status(VECTOR_READY_MARKER)).toEqual({ has_table: hasTable, done: false });
      if (hasTable) {
        const collectionId = await database.collection();
        const file = await database.file(collectionId, 'embedded.txt');
        await database.chunk(file.fileId, file.versionId, 0, 'vector text', Array.from({ length: 512 }, () => 0.1));
        expect(await backfill.hasJsonOnlyChunks()).toBe(true);
        expect(await backfill.copyBatch(1_000)).toBe(1);
        expect(await backfill.copyBatch(1_000)).toBe(0);
        expect(await backfill.hasJsonOnlyChunks()).toBe(false);
        expect(await backfill.clearJsonBatch(1_000)).toBe(1);
        expect((await database.pool.query('SELECT embedding_json FROM file_search_chunks WHERE file_id=$1', [file.fileId])).rows[0].embedding_json).toBeNull();
      }
      await backfill.markReady(VECTOR_READY_MARKER);
      await backfill.markReady(VECTOR_READY_MARKER);
      expect((await backfill.status(VECTOR_READY_MARKER)).done).toBe(true);
    } finally { session.release() }
  });
});
