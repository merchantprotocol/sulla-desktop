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
const integration = enabled ? test : test.skip;

integration('every allowed current file has one explicit outcome and changed bytes queue the new version', async() => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await migrate(db);
    await db.query('TRUNCATE collections CASCADE');
    const collectionId = (await db.query(`INSERT INTO collections
      (owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state)
      VALUES('index-owner','Index accounting','knowledge','desktop-only','{}','{}','native') RETURNING id`)).rows[0].id;

    const createFile = async(path:string) => {
      const fileId = (await db.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime)
        VALUES($1,$2,'user','index-owner','text/plain') RETURNING id`, [collectionId, path])).rows[0].id;
      const versionId = (await db.query(`INSERT INTO file_versions(file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id)
        VALUES($1,$2,1,'user','index-owner','index-device') RETURNING id`, [fileId, collectionId])).rows[0].id;
      await db.query('UPDATE files SET current_version_id=$2,size=1 WHERE id=$1', [fileId, versionId]);
      return { fileId, versionId };
    };

    const indexed = await createFile('indexed.txt');
    const pending = await createFile('pending.txt');
    const failed = await createFile('failed.txt');
    const protectedFile = await createFile('protected-wallet.fixture');
    await db.query("UPDATE files SET extraction_status='indexed',extraction_reason_code=NULL,extraction_reason=NULL,extracted_at=NOW() WHERE id=$1", [indexed.fileId]);
    await db.query("UPDATE files SET extraction_status='failed',extraction_reason_code=NULL,extraction_reason=NULL,extracted_at=NOW() WHERE id=$1", [failed.fileId]);
    await db.query('DELETE FROM file_index_jobs WHERE file_id=ANY($1::uuid[])', [[indexed.fileId, pending.fileId, failed.fileId]]);
    await db.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [protectedFile.fileId]);

    await reconcileIndexingAccounting(db);

    const accounted = (await db.query(`SELECT f.path,f.extraction_status,j.status job_status,f.extraction_reason_code,f.extraction_reason,j.reason_code job_reason_code,j.reason job_reason
      FROM files f JOIN file_index_jobs j ON j.version_id=f.current_version_id
      WHERE f.collection_id=$1 AND f.id<>$2 ORDER BY f.path`, [collectionId, protectedFile.fileId])).rows;
    assert.deepEqual(accounted.map(row => [row.path, row.extraction_status, row.job_status]), [
      ['failed.txt', 'failed', 'failed'],
      ['indexed.txt', 'indexed', 'indexed'],
      ['pending.txt', 'pending', 'pending'],
    ]);
    for (const row of accounted) {
      assert(row.extraction_reason_code && row.extraction_reason, `${ row.path } must expose a file outcome reason`);
      assert(row.job_reason_code && row.job_reason, `${ row.path } must expose a queue outcome reason`);
    }
    assert.equal((await db.query('SELECT count(*)::int count FROM file_index_jobs WHERE file_id=$1', [protectedFile.fileId])).rows[0].count, 0);

    const changedVersionId = (await db.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,2,'user','index-owner','index-device') RETURNING id`, [pending.fileId, collectionId, pending.versionId])).rows[0].id;
    await db.query('UPDATE files SET current_version_id=$2,size=2 WHERE id=$1', [pending.fileId, changedVersionId]);
    const changed = (await db.query(`SELECT f.extraction_status,f.extraction_reason_code,j.status job_status,j.reason_code
      FROM files f JOIN file_index_jobs j ON j.version_id=f.current_version_id WHERE f.id=$1`, [pending.fileId])).rows[0];
    assert.deepEqual(changed, { extraction_status: 'pending', extraction_reason_code: 'queued', job_status: 'pending', reason_code: 'queued' });
  } finally {
    await db.end();
  }
});
