// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Concurrent mount creates into ONE collection on real Postgres, with the indexer and the audit
// drainer running beside them. Always asserts that no file is lost, duplicated or refused.
// SULLA_FILES_BENCH_TARGETS=1 also asserts the throughput targets (>= 50 files/s, p99 < 1 s,
// no transaction open > 1 s). SULLA_FILES_BENCH_WRITERS / _FILES size the run (default 8 x 200);
// SULLA_FILES_BENCH_WAITS=1 prints the most-sampled wait events.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FilesWriteBenchmark } from './FilesWriteBenchmark.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL ?? '';
const writers = Number(process.env.SULLA_FILES_BENCH_WRITERS ?? 8);
const filesPerWriter = Number(process.env.SULLA_FILES_BENCH_FILES ?? 200);
const assertTargets = process.env.SULLA_FILES_BENCH_TARGETS === '1';
// SULLA_FILES_BENCH_BACKGROUND=0 isolates the writers; =indexer or =audit runs only that one.
const background = process.env.SULLA_FILES_BENCH_BACKGROUND ?? 'all';

describe.skipIf(!databaseUrl)('concurrent mount writes into one collection (real Postgres)', () => {
  const bench = new FilesWriteBenchmark(databaseUrl, { writers, filesPerWriter, directories: 10, indexer: ['all', 'indexer'].includes(background), audit: ['all', 'audit'].includes(background) });

  beforeAll(async() => { await bench.start(); bench.startBackground() }, 120_000);
  afterAll(async() => { await bench.stop() }, 120_000);

  // risk: data loss — concurrent creates must each land exactly once, at their own path, with a version and a journal entry.
  it('stores every concurrently created file exactly once while indexing and audit delivery run', async() => {
    const runId = randomUUID().slice(0, 8);
    const result = await bench.run(runId);
    console.log(`[files-bench] writers=${ writers } files=${ result.files } seconds=${ result.seconds.toFixed(2) } files/s=${ result.filesPerSecond.toFixed(1) } `
      + `p50=${ result.p50.toFixed(0) }ms p95=${ result.p95.toFixed(0) }ms p99=${ result.p99.toFixed(0) }ms max=${ result.max.toFixed(0) }ms `
      + `maxTransaction=${ result.maxTransactionMs.toFixed(0) }ms failures=${ result.failures.length } `
      + `auditBacklog=${ await bench.scalar('SELECT COUNT(*) n FROM files_audit_spool') } indexBacklog=${ await bench.scalar("SELECT COUNT(*) n FROM file_index_jobs WHERE status IN ('pending','indexing')") }`);

    expect(result.failures).toEqual([]);
    const stored = await bench.storedPaths(runId);
    const expected = bench.paths(runId).flat();
    expect(stored.size).toBe(expected.length);
    expect(expected.filter(path => stored.get(path) !== 1)).toEqual([]);
    const prefix = `bench/${ runId }/`;
    expect(await bench.scalar(`SELECT COUNT(*) n FROM journal j JOIN files f ON f.id=j.file_id
      WHERE f.collection_id=$1 AND starts_with(f.path,$2) AND j.op='put' AND j.version_id=f.current_version_id`, [bench.collectionId, prefix])).toBe(expected.length);
    // Each shared directory exists once, so concurrent parent creation raced safely.
    expect(await bench.scalar('SELECT COUNT(*) n FROM file_folders WHERE collection_id=$1 AND starts_with(path,$2)', [bench.collectionId, prefix])).toBe(10);

    if (assertTargets) {
      expect(result.filesPerSecond).toBeGreaterThanOrEqual(50);
      expect(result.p99).toBeLessThan(1_000);
      expect(result.maxTransactionMs).toBeLessThan(1_000);
    }
  }, 900_000);
});
