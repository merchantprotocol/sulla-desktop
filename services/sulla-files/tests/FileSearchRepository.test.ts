// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Search reads and the FileSearch service against real Postgres with every Files migration applied.
// Point SULLA_FILES_TEST_DATABASE_URL at a throwaway database; the spec creates and drops its own schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FileSearchRepository } from '../src/Repositories/FileSearchRepository.js';
import { VECTOR_READY_MARKER, VectorStateRepository } from '../src/Repositories/VectorStateRepository.js';
import { FileSearch } from '../src/search.js';
import { VectorCapability } from '../src/Services/VectorCapability.js';
import { databaseUrl, SearchIndexDatabase } from './SearchIndexDatabase.js';

const embedder = { dim: 512, embed: () => new Float32Array(512) } as any;

describe.skipIf(!databaseUrl)('file search repository and service (real Postgres)', () => {
  const database = new SearchIndexDatabase(databaseUrl ?? '');
  let repository:FileSearchRepository;
  let search:FileSearch;
  let mine = '';
  let other = '';

  beforeAll(async() => {
    await database.create();
    repository = new FileSearchRepository(database.pool);
    // Keyword + JSON fallback path: the vector "ready" marker is never written in this schema.
    search = new FileSearch(database.pool, embedder);
  });
  afterAll(async() => { await database.drop() });
  beforeEach(async() => {
    mine = await database.collection();
    other = await database.collection();
  });

  async function indexed(collectionId:string, path:string, text:string, options:{ mime?:string } = {}) {
    const file = await database.file(collectionId, path, options);
    await database.chunk(file.fileId, file.versionId, 0, text, [1, 0]);
    await database.pool.query("UPDATE file_index_jobs SET status='indexed',reason_code='text_extracted' WHERE version_id=$1", [file.versionId]);
    return file;
  }

  const paths = (rows:{ path:string }[]) => rows.map(row => row.path).sort();

  // risk: data leak — a search must never return files outside the caller's granted collections.
  it('returns keyword matches only from granted collections and the requested collection', async() => {
    await indexed(mine, 'mine.txt', 'quarterly zebra report');
    await indexed(other, 'theirs.txt', 'quarterly zebra report');

    expect(paths(await repository.keyword({}, [{ collectionId: mine }], 'zebra'))).toEqual(['mine.txt']);
    expect(paths(await repository.keyword({}, [{ collectionId: mine }, { collectionId: other }], 'zebra'))).toEqual(['mine.txt', 'theirs.txt']);

    const scoped = await search.search({ query: 'zebra', collectionId: other }, [{ collectionId: mine }, { collectionId: other }]);
    expect(scoped.results.map(result => result.path)).toEqual(['theirs.txt']);
    expect(scoped.results[0]).toMatchObject({ title: 'theirs.txt', why: 'keyword match', snippet: 'quarterly zebra report' });
    const notGranted = await search.search({ query: 'zebra', collectionId: other }, [{ collectionId: mine }]);
    expect(notGranted).toEqual({ results: [], coverage: { total: 0, pending: 0, indexing: 0, indexed: 0, partial: 0, unsupported: 0, failed: 0, complete: true } });
  });

  // risk: protected, deleted, vault or system-log content surfaces in search results.
  it('hides protected, deleted, vault-path and logs-area files', async() => {
    const visible = await indexed(mine, 'notes/plan.txt', 'walrus plan');
    const secret = await indexed(mine, 'notes/secret.txt', 'walrus secret');
    await database.pool.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [secret.fileId]);
    const gone = await indexed(mine, 'notes/gone.txt', 'walrus gone');
    await database.pool.query('UPDATE files SET deleted_at=NOW() WHERE id=$1', [gone.fileId]);
    await indexed(mine, 'Vault/keys.txt', 'walrus key');
    await indexed(mine, 'my-wallet/seed.txt', 'walrus seed');
    const logs = await database.collection('logs');
    const logged = await database.file(logs, 'app.log');
    await database.chunk(logged.fileId, logged.versionId, 0, 'walrus log');
    expect(visible.fileId).toBeDefined();

    const scopes = [{ collectionId: mine }, { collectionId: logs }];
    expect(paths(await repository.keyword({}, scopes, 'walrus'))).toEqual(['notes/plan.txt']);
    expect(paths(await repository.jsonEmbeddingCandidates({}, scopes))).toEqual(['notes/plan.txt']);
  });

  // risk: superseded text keeps matching after an edit — only the current version's chunks may match.
  it('matches only the current version\'s chunks', async() => {
    const file = await indexed(mine, 'draft.txt', 'obsolete pelican');
    const current = await database.version(file.fileId, mine);
    await database.chunk(file.fileId, current, 0, 'current heron');
    expect(await repository.keyword({}, [{ collectionId: mine }], 'pelican')).toEqual([]);
    expect(paths(await repository.keyword({}, [{ collectionId: mine }], 'heron'))).toEqual(['draft.txt']);
  });

  // risk: agent recall reads an unpublished draft (e.g. a draft SKILL.md).
  it('excludes unpublished drafts when publishedOnly is set and applies folder/type filters', async() => {
    const file = await indexed(mine, 'Use Cases/skill.md', 'otter skill', { mime: 'text/markdown' });
    const draft = (await database.pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,10,'agent-run','run-1','spec-device') RETURNING id`, [file.fileId, mine])).rows[0].id;
    await database.pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [file.fileId, draft]);
    await database.chunk(file.fileId, draft, 0, 'otter draft');
    await indexed(mine, 'Other/otter.txt', 'otter elsewhere');

    const scopes = [{ collectionId: mine }];
    expect(paths(await repository.keyword({}, scopes, 'otter'))).toEqual(['Other/otter.txt', 'Use Cases/skill.md']);
    expect(paths(await repository.keyword({ publishedOnly: true }, scopes, 'otter'))).toEqual(['Other/otter.txt']);
    expect(paths(await repository.keyword({ folder: 'Other/' }, scopes, 'otter'))).toEqual(['Other/otter.txt']);
    expect(paths(await repository.keyword({ type: 'text/markdown' }, scopes, 'otter'))).toEqual(['Use Cases/skill.md']);
    // LIKE wildcards in a folder name are literal.
    expect(await repository.keyword({ folder: 'Oth_r/' }, scopes, 'otter')).toEqual([]);
  });

  // risk: the UI claims search is complete while files are still pending or failed.
  it('counts index coverage per status over visible current versions', async() => {
    await indexed(mine, 'done.txt', 'done');
    const partial = await indexed(mine, 'partial.txt', 'partial');
    await database.pool.query("UPDATE file_index_jobs SET reason_code='text_extracted_partial' WHERE version_id=$1", [partial.versionId]);
    await database.file(mine, 'waiting.txt');
    const failed = await database.file(mine, 'failed.txt');
    await database.pool.query("UPDATE file_index_jobs SET status='failed' WHERE version_id=$1", [failed.versionId]);

    expect(await repository.coverage({}, [{ collectionId: mine }])).toEqual({ total: 4, pending: 1, indexing: 0, indexed: 2, partial: 1, unsupported: 0, failed: 1 });
    const empty = await search.search({ query: '  ' }, [{ collectionId: mine }]);
    expect(empty.results).toEqual([]);
    expect(empty.coverage.complete).toBe(false);
  });

  // risk: semantic search reads halfvec before the backfill finished (empty results) or never switches.
  it('reports vector readiness only after the backfill marker exists, and caches a positive answer', async() => {
    const state = new VectorStateRepository(database.pool);
    const hasTable = await database.vectorsAvailable();
    expect(await state.tableExists()).toBe(hasTable);
    expect(await state.searchReady()).toBe(false);
    let now = 0;
    const capability = new VectorCapability(state, () => now);
    expect(await capability.searchReady()).toBe(false);
    await database.pool.query('INSERT INTO files_schema_migrations(version) VALUES($1)', [VECTOR_READY_MARKER]);
    try {
      expect(await state.searchReady()).toBe(hasTable);
      expect(await capability.searchReady()).toBe(false); // negative answer cached for 15 s
      now = 15_001;
      expect(await capability.searchReady()).toBe(hasTable);
    } finally { await database.pool.query('DELETE FROM files_schema_migrations WHERE version=$1', [VECTOR_READY_MARKER]) }
  });
});
