// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { migrate } from './db.js';
import { reconcileIndexingAccounting } from './indexing.js';

const databaseUrl = process.env.SULLA_FILES_INDEX_ACCOUNTING_TEST_URL;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';
const enabled = Boolean(databaseUrl && process.env.SULLA_FILES_ALLOW_DESTRUCTIVE_TESTS === '1' && /(^test_|_test$)/.test(databaseName));
if (process.env.CI && !enabled) throw new Error('Index accounting CI must run against an explicitly enabled synthetic test database.');
const integration = enabled ? test : test.skip;

type Outcome = 'pending' | 'indexing' | 'indexed' | 'failed' | 'unsupported' | 'invalid-state';

integration('restart reconciliation accounts for every eligible current file and changed indexed bytes requeue', async() => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await migrate(db);
    await db.query('TRUNCATE collections CASCADE');
    const collectionId = (await db.query(`INSERT INTO collections
      (owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state)
      VALUES('index-owner','Index accounting','knowledge','desktop-only','{}','{}','native') RETURNING id`)).rows[0].id;
    const logsCollectionId = (await db.query(`INSERT INTO collections
      (owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state,system_area)
      VALUES('index-system','Logs','knowledge','desktop-only','{}','{}','native','logs') RETURNING id`)).rows[0].id;

    const createFile = async(path:string, status:Outcome, reasonCode:string | null = null, reason:string | null = null, targetCollectionId = collectionId) => {
      const fileId = (await db.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime)
        VALUES($1,$2,'user','index-owner','text/plain') RETURNING id`, [targetCollectionId, path])).rows[0].id;
      const versionId = (await db.query(`INSERT INTO file_versions(file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id)
        VALUES($1,$2,1,'user','index-owner','index-device') RETURNING id`, [fileId, targetCollectionId])).rows[0].id;
      // The version trigger intentionally owns the initial queued state. Apply the synthetic
      // restart outcome afterward so this fixture models a prior completed/interrupted run.
      await db.query('UPDATE files SET current_version_id=$2,size=1 WHERE id=$1', [fileId, versionId]);
      await db.query(`UPDATE files SET extraction_status=$2,extraction_reason_code=$3,extraction_reason=$4,
        extracted_at=CASE WHEN $2 IN('indexed','failed','unsupported') THEN NOW() END WHERE id=$1`, [fileId, status, reasonCode, reason]);
      return { fileId, versionId };
    };
    const setJob = (fileId:string, versionId:string, status:string, reasonCode = 'contradictory', reason = 'Contradictory synthetic state.') => db.query(`INSERT INTO file_index_jobs(file_id,version_id,status,reason_code,reason,attempts,started_at,finished_at)
      VALUES($1,$2,$3,$4,$5,2,CASE WHEN $3='indexing' THEN NOW() END,CASE WHEN $3 IN('indexed','failed','unsupported') THEN NOW() END)
      ON CONFLICT(version_id) DO UPDATE SET status=EXCLUDED.status,reason_code=EXCLUDED.reason_code,reason=EXCLUDED.reason,attempts=EXCLUDED.attempts,started_at=EXCLUDED.started_at,finished_at=EXCLUDED.finished_at`, [fileId, versionId, status, reasonCode, reason]);

    const indexedMissing = await createFile('indexed-missing.txt', 'indexed');
    const indexedPartial = await createFile('indexed-partial.txt', 'indexed', 'text_extracted_partial', 'Text was partially indexed.');
    const failedMissing = await createFile('failed-missing.txt', 'failed');
    const unsupportedMissing = await createFile('unsupported-missing.bin', 'unsupported');
    const pendingContradiction = await createFile('pending-vs-failed.txt', 'pending', 'queued', 'Waiting for local indexing.');
    const indexedContradiction = await createFile('indexed-vs-pending.txt', 'indexed', 'text_extracted', 'Text indexed locally.');
    const failedContradiction = await createFile('failed-vs-indexed.txt', 'failed', 'retry_exhausted', 'Indexing failed after three local attempts.');
    const interrupted = await createFile('interrupted.txt', 'indexing', 'indexing', 'Local extraction is in progress.');
    const invalid = await createFile('invalid.txt', 'invalid-state');
    const deleted = await createFile('deleted.txt', 'pending', 'queued', 'Waiting for local indexing.');
    const protectedFile = await createFile('protected-wallet.fixture', 'pending', 'queued', 'Waiting for local indexing.');
    const excluded = await createFile('audit.log', 'pending', 'queued', 'Waiting for local indexing.', logsCollectionId);

    await db.query('DELETE FROM file_index_jobs WHERE file_id=ANY($1::uuid[])', [[indexedMissing.fileId, indexedPartial.fileId, failedMissing.fileId, unsupportedMissing.fileId]]);
    await setJob(pendingContradiction.fileId, pendingContradiction.versionId, 'failed');
    await setJob(indexedContradiction.fileId, indexedContradiction.versionId, 'pending');
    await setJob(failedContradiction.fileId, failedContradiction.versionId, 'indexed');
    await setJob(interrupted.fileId, interrupted.versionId, 'indexing');
    await db.query('UPDATE files SET deleted_at=NOW() WHERE id=$1', [deleted.fileId]);
    await db.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [protectedFile.fileId]);

    await reconcileIndexingAccounting(db);

    const eligible = (await db.query(`SELECT f.path,f.extraction_status,j.status job_status,f.extraction_reason_code,f.extraction_reason,j.reason_code job_reason_code,j.reason job_reason,j.attempts
      FROM files f JOIN file_index_jobs j ON j.version_id=f.current_version_id
      WHERE f.collection_id=$1 AND f.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
      ORDER BY f.path`, [collectionId])).rows;
    assert.deepEqual(eligible.map(row => [row.path, row.extraction_status, row.job_status]), [
      ['failed-missing.txt', 'failed', 'failed'],
      ['failed-vs-indexed.txt', 'failed', 'failed'],
      ['indexed-missing.txt', 'indexed', 'indexed'],
      ['indexed-partial.txt', 'indexed', 'indexed'],
      ['indexed-vs-pending.txt', 'indexed', 'indexed'],
      ['interrupted.txt', 'pending', 'pending'],
      ['invalid.txt', 'failed', 'failed'],
      ['pending-vs-failed.txt', 'pending', 'pending'],
      ['unsupported-missing.bin', 'unsupported', 'unsupported'],
    ]);
    for (const row of eligible) {
      assert(row.extraction_reason_code && row.extraction_reason, `${ row.path } must expose a file outcome reason`);
      assert(row.job_reason_code && row.job_reason, `${ row.path } must expose a queue outcome reason`);
    }
    assert.equal(eligible.find(row => row.path === 'indexed-partial.txt')?.job_reason_code, 'text_extracted_partial');
    assert.equal(eligible.find(row => row.path === 'interrupted.txt')?.attempts, 0);
    assert.equal((await db.query('SELECT count(*)::int count FROM file_index_jobs WHERE file_id=ANY($1::uuid[])', [[deleted.fileId, protectedFile.fileId, excluded.fileId]])).rows[0].count, 0);

    const beforeSecondRestart = (await db.query(`SELECT f.path,f.extraction_status,f.extraction_reason_code,f.extraction_reason,j.status,j.reason_code,j.reason,j.attempts
      FROM files f JOIN file_index_jobs j ON j.version_id=f.current_version_id WHERE f.collection_id=$1 ORDER BY f.path`, [collectionId])).rows;
    await reconcileIndexingAccounting(db);
    const afterSecondRestart = (await db.query(`SELECT f.path,f.extraction_status,f.extraction_reason_code,f.extraction_reason,j.status,j.reason_code,j.reason,j.attempts
      FROM files f JOIN file_index_jobs j ON j.version_id=f.current_version_id WHERE f.collection_id=$1 ORDER BY f.path`, [collectionId])).rows;
    assert.deepEqual(afterSecondRestart, beforeSecondRestart, 'a second restart must be idempotent');

    const changedVersionId = (await db.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,2,'user','index-owner','index-device') RETURNING id`, [indexedContradiction.fileId, collectionId, indexedContradiction.versionId])).rows[0].id;
    await db.query('UPDATE files SET current_version_id=$2,size=2 WHERE id=$1', [indexedContradiction.fileId, changedVersionId]);
    const changed = (await db.query(`SELECT f.extraction_status,f.extraction_reason_code,j.status job_status,j.reason_code
      FROM files f JOIN file_index_jobs j ON j.version_id=f.current_version_id WHERE f.id=$1`, [indexedContradiction.fileId])).rows[0];
    assert.deepEqual(changed, { extraction_status: 'pending', extraction_reason_code: 'queued', job_status: 'pending', reason_code: 'queued' });
    assert.equal((await db.query('SELECT count(*)::int count FROM file_index_jobs WHERE file_id=$1 AND version_id=$2', [indexedContradiction.fileId, indexedContradiction.versionId])).rows[0].count, 1, 'old terminal history remains until restart cleanup');
    await reconcileIndexingAccounting(db);
    assert.equal((await db.query('SELECT count(*)::int count FROM file_index_jobs WHERE file_id=$1', [indexedContradiction.fileId])).rows[0].count, 1, 'restart removes the stale version job');
  } finally {
    await db.end();
  }
});
