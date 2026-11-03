// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { migrate } from './db.js';
import { persistRecordingEnrichment } from './recordingEnrichment.js';

const databaseUrl = process.env.SULLA_FILES_RECORDING_PRIVACY_TEST_URL;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';
const enabled = Boolean(databaseUrl && process.env.SULLA_FILES_ALLOW_DESTRUCTIVE_TESTS === '1' && /(^test_|_test$)/.test(databaseName));
if (process.env.CI && !enabled) throw new Error('Recording privacy CI must run against an explicitly enabled synthetic test database.');
const integration = enabled ? test : test.skip;

integration('recording persistence abandons protected, deleted, and excluded races without recreating plaintext', async() => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await migrate(db);
    const scenarios = ['protected', 'deleted', 'excluded'] as const;
    for (const scenario of scenarios) {
      await db.query('TRUNCATE collections CASCADE');
      const collectionId = (await db.query(`INSERT INTO collections
        (owner_user_id,name,kind,home,explorer_path,encrypted_data_key,dedup_key_ciphertext,compatibility_state)
        VALUES('recording-owner',$1,'knowledge','desktop-only',$2,'{}','{}','native') RETURNING id`, [`Recording ${ scenario }`, `recording-${ scenario }`])).rows[0].id;
      const fileId = (await db.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime)
        VALUES($1,$2,'user','recording-owner','audio/wav') RETURNING id`, [collectionId, `${ scenario }.wav`])).rows[0].id;
      const versionId = (await db.query(`INSERT INTO file_versions(file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id)
        VALUES($1,$2,1,'user','recording-owner','recording-device') RETURNING id`, [fileId, collectionId])).rows[0].id;
      await db.query("UPDATE files SET current_version_id=$2,size=1,extraction_status='indexing' WHERE id=$1", [fileId, versionId]);
      await db.query("INSERT INTO recording_enrichment_jobs(file_id,version_id,status) VALUES($1,$2,'processing')", [fileId, versionId]);
      await db.query("INSERT INTO file_search_text(file_id,path,search_text) VALUES($1,$2,'prior synthetic transcript')", [fileId, `${ scenario }.wav`]);
      await db.query(`INSERT INTO recording_metadata(file_id,version_id,transcript,chapters,generator)
        VALUES($1,$2,'[{"start":0,"end":1,"text":"prior synthetic transcript"}]','[]','synthetic')`, [fileId, versionId]);

      const invalidator = await db.connect();
      try {
        await invalidator.query('BEGIN');
        if (scenario === 'protected') {
          await invalidator.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [fileId]);
          await invalidator.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [fileId]);
        } else if (scenario === 'deleted') {
          await invalidator.query('UPDATE files SET deleted_at=NOW() WHERE id=$1', [fileId]);
        } else {
          await invalidator.query('UPDATE collections SET system_area=\'logs\' WHERE id=$1', [collectionId]);
        }
        let finished = false;
        const persistence = persistRecordingEnrichment(db, {
          fileId, versionId, language: 'en', duration: 1,
          transcript: [{ start: 0, end: 1, text: `late ${ scenario } transcript` }], chapters: [],
        }).then(result => { finished = true; return result });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(finished, false, `${ scenario } invalidation lock must serialize the final persistence check`);
        await invalidator.query('COMMIT');
        assert.equal(await persistence, 'abandoned-ineligible');
      } catch (error) {
        await invalidator.query('ROLLBACK');
        throw error;
      } finally {
        invalidator.release();
      }

      const counts = (await db.query(`SELECT
        (SELECT count(*)::int FROM recording_metadata WHERE file_id=$1) metadata,
        (SELECT count(*)::int FROM recording_enrichment_jobs WHERE file_id=$1) recording_jobs,
        (SELECT count(*)::int FROM file_search_text WHERE file_id=$1) search_text`, [fileId])).rows[0];
      assert.deepEqual(counts, { metadata: 0, recording_jobs: 0, search_text: 0 }, `${ scenario } leaves no transcript-derived plaintext`);
    }
  } finally {
    await db.end();
  }
});

integration('stale recording output preserves current-version transcript derivatives', async() => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await migrate(db);
    await db.query('TRUNCATE collections CASCADE');
    const collectionId = (await db.query(`INSERT INTO collections
      (owner_user_id,name,kind,home,explorer_path,encrypted_data_key,dedup_key_ciphertext,compatibility_state)
      VALUES('recording-owner','Version preservation','knowledge','desktop-only','recording-version','{}','{}','native') RETURNING id`)).rows[0].id;
    const fileId = (await db.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime)
      VALUES($1,'version.wav','user','recording-owner','audio/wav') RETURNING id`, [collectionId])).rows[0].id;
    const staleVersionId = (await db.query(`INSERT INTO file_versions(file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,1,'user','recording-owner','recording-device') RETURNING id`, [fileId, collectionId])).rows[0].id;
    const currentVersionId = (await db.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,2,'user','recording-owner','recording-device') RETURNING id`, [fileId, collectionId, staleVersionId])).rows[0].id;
    await db.query("UPDATE files SET current_version_id=$2,size=2,extraction_status='indexed' WHERE id=$1", [fileId, currentVersionId]);
    await db.query("INSERT INTO recording_enrichment_jobs(file_id,version_id,status) VALUES($1,$2,'processing')", [fileId, staleVersionId]);
    await db.query("INSERT INTO file_search_text(file_id,path,search_text) VALUES($1,'version.wav','current synthetic transcript')", [fileId]);
    await db.query(`INSERT INTO recording_metadata(file_id,version_id,transcript,chapters,generator)
      VALUES($1,$2,'[{"start":0,"end":1,"text":"current synthetic transcript"}]','[]','synthetic')`, [fileId, currentVersionId]);

    const result = await persistRecordingEnrichment(db, {
      fileId, versionId: staleVersionId, language: 'en', duration: 1,
      transcript: [{ start: 0, end: 1, text: 'late stale transcript' }], chapters: [],
    });
    assert.equal(result, 'abandoned-stale');
    assert.deepEqual((await db.query('SELECT version_id,transcript FROM recording_metadata WHERE file_id=$1', [fileId])).rows,
      [{ version_id: currentVersionId, transcript: [{ start: 0, end: 1, text: 'current synthetic transcript' }] }]);
    assert.deepEqual((await db.query('SELECT search_text FROM file_search_text WHERE file_id=$1', [fileId])).rows,
      [{ search_text: 'current synthetic transcript' }]);
    assert.equal((await db.query('SELECT count(*)::int count FROM recording_enrichment_jobs WHERE version_id=$1', [staleVersionId])).rows[0].count, 0);
  } finally {
    await db.end();
  }
});
