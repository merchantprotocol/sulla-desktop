// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Runs the real snapshot-retention SQL against Postgres. Point SULLA_FILES_TEST_DATABASE_URL at a throwaway
// database. Each run creates and drops its own schema: file_automerge_versions as created by 041, then the real 063.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AutomergeSnapshotRepository } from '../src/Repositories/AutomergeSnapshotRepository.js';
import { AutomergeSnapshotRetention } from '../src/automergeSnapshotRetention.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');
const FIRST_FILE = '00000000-0000-0000-0000-000000000000';

describe.skipIf(!databaseUrl)('Automerge snapshot retention SQL (real Postgres)', () => {
  const schema = `files_automerge_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${ schema }` });
  const repository = new AutomergeSnapshotRepository(pool);

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query('CREATE TABLE file_versions(id uuid PRIMARY KEY)');
    await pool.query('CREATE TABLE files(id uuid PRIMARY KEY,current_version_id uuid)');
    // As created by 041_automerge_metadata.sql (that migration also alters tables this spec does not need).
    await pool.query(`CREATE TABLE file_automerge_versions(version_id UUID PRIMARY KEY REFERENCES file_versions(id) ON DELETE CASCADE,
      file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,document BYTEA NOT NULL,heads JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(migration('063_automerge_document_storage.sql'));
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => { await pool.query('TRUNCATE file_automerge_versions, file_automerge_docs, files, file_versions') });

  async function file(id = randomUUID()):Promise<string> { await pool.query('INSERT INTO files(id) VALUES($1)', [id]); return id }

  /** Inserts a snapshot `ageSql` before now (e.g. '60 days'), returns its version id. */
  async function snapshot(fileId:string, createdAtSql:string):Promise<string> {
    const versionId = randomUUID();
    await pool.query('INSERT INTO file_versions(id) VALUES($1)', [versionId]);
    await pool.query(`INSERT INTO file_automerge_versions(version_id,file_id,document,heads,created_at) VALUES($1,$2,'\\x01'::bytea,'[]'::jsonb,${ createdAtSql })`, [versionId, fileId]);
    return versionId;
  }

  async function kept(fileId:string):Promise<string[]> {
    return (await pool.query('SELECT version_id::text AS id FROM file_automerge_versions WHERE file_id=$1 AND document IS NOT NULL ORDER BY created_at', [fileId])).rows.map(row => row.id);
  }

  async function seedHistory() {
    const fileId = await file();
    const old:string[] = [];
    for (let day = 60; day >= 55; day--) old.push(await snapshot(fileId, `NOW() - INTERVAL '${ day } days'`));
    const dayStart = "date_trunc('day', NOW()) - INTERVAL '2 days'";
    const morning = await snapshot(fileId, `${ dayStart } + INTERVAL '10 hours'`);
    const late = await snapshot(fileId, `${ dayStart } + INTERVAL '11 hours'`);
    const lastOfDay = await snapshot(fileId, `${ dayStart } + INTERVAL '12 hours'`);
    const newer = await snapshot(fileId, "NOW() - INTERVAL '2 minutes'");
    const newest = await snapshot(fileId, "NOW() - INTERVAL '1 minute'");
    await pool.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, old[2]]);
    return { fileId, old, morning, late, lastOfDay, newer, newest };
  }

  // risk: data loss — retention must keep the newest N, each day's last snapshot in the window, and the current version.
  it('blanks only redundant payloads and never deletes snapshot rows', async() => {
    const history = await seedHistory();
    const retention = new AutomergeSnapshotRetention(pool, 2, 30, 100, 5_000, 2_000);
    expect(await retention.prune()).toBe(7);
    expect(await kept(history.fileId)).toEqual([history.old[2], history.lastOfDay, history.newer, history.newest]);
    const rows = await pool.query('SELECT COUNT(*)::int AS n FROM file_automerge_versions WHERE file_id=$1', [history.fileId]);
    expect(rows.rows[0].n).toBe(11);
  });

  // risk: unbounded work — one statement must never blank more than the batch cap, oldest first.
  it('caps one file prune at the batch size, oldest snapshots first', async() => {
    const history = await seedHistory();
    const client = await pool.connect();
    try {
      expect(await repository.pruneFile(client, history.fileId, { keepRecent: 2, dailyDays: 30, batchSize: 3 }, 2_000)).toBe(3);
    } finally { client.release() }
    const blanked = (await pool.query('SELECT version_id::text AS id FROM file_automerge_versions WHERE file_id=$1 AND document IS NULL ORDER BY created_at', [history.fileId])).rows.map(row => row.id);
    expect(blanked).toEqual([history.old[0], history.old[1], history.old[3]]);
  });

  // risk: a pruner that rescans from the start or skips files never finishes a lap on a large table.
  it('pages distinct file ids after the cursor and bounds the index rows read', async() => {
    const [a, b, c] = ['10000000-0000-4000-8000-000000000000', '20000000-0000-4000-8000-000000000000', '30000000-0000-4000-8000-000000000000'];
    for (const id of [c, a, b]) await file(id);
    for (const id of [a, a, a, b, c]) await snapshot(id, 'NOW()');
    expect(await repository.nextFileIds(FIRST_FILE, 100)).toEqual([a, b, c]);
    expect(await repository.nextFileIds(a, 100)).toEqual([b, c]);
    expect(await repository.nextFileIds(FIRST_FILE, 2)).toEqual([a]);
    expect(await repository.nextFileIds(c, 100)).toEqual([]);
  });
});
