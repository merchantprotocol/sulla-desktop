// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real Postgres: dropping a retired system collection (RetiredSystemAreaRepository +
// RetiredSystemAreaCleaner). Own schema, real 030 system-area migration.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TransactionRunner } from '../src/FilesTransaction.js';
import { RetiredSystemAreaRepository } from '../src/Repositories/RetiredSystemAreaRepository.js';
import { RetiredSystemAreaCleaner } from '../src/Services/RetiredSystemAreaCleaner.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('retired system area cleanup (real Postgres)', () => {
  const schema = `files_retired_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${ schema }` });
  const deleted:string[] = []; const logs:string[] = []; let drains = 0;
  const cleaner = () => new RetiredSystemAreaCleaner(new RetiredSystemAreaRepository(pool), new TransactionRunner(pool, undefined, { slowTransaction: () => undefined }),
    async(_collectionId, chunkId) => { deleted.push(chunkId) },
    async() => { drains++; await pool.query('DELETE FROM file_chunk_gc') },
    message => logs.push(message));

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query('CREATE TABLE collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
    await pool.query(migration('030_system_areas.sql'));
    await pool.query('CREATE TABLE chunks(id text,collection_id uuid REFERENCES collections(id) ON DELETE CASCADE)');
    for (const table of ['files', 'file_chunk_gc', 'journal', 'file_purge_tombstones', 'file_share_links', 'file_roots']) {
      await pool.query(`CREATE TABLE ${ table }(collection_id uuid REFERENCES collections(id))`);
    }
    await pool.query('CREATE TABLE file_versions(chunk_collection_id uuid)');
    await pool.query('CREATE TABLE files_legacy_file_map(source_collection_id uuid REFERENCES collections(id),shadow_collection_id uuid)');
    await pool.query('CREATE TABLE files_legacy_collection_map(source_collection_id uuid,shadow_collection_id uuid REFERENCES collections(id))');
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE collections, chunks, files, file_chunk_gc, journal, file_purge_tombstones, file_share_links, file_roots, file_versions, files_legacy_file_map, files_legacy_collection_map');
    deleted.length = 0; logs.length = 0; drains = 0;
  });

  async function retired() {
    const id = (await pool.query("INSERT INTO collections(system_area) VALUES('training-data') RETURNING id")).rows[0].id as string;
    await pool.query("INSERT INTO chunks(id,collection_id) VALUES('c1',$1),('c2',$1)", [id]);
    for (const table of ['journal', 'file_purge_tombstones', 'file_share_links', 'file_roots']) await pool.query(`INSERT INTO ${ table }(collection_id) VALUES($1)`, [id]);
    await pool.query('INSERT INTO files_legacy_file_map(source_collection_id) VALUES($1)', [id]);
    await pool.query('INSERT INTO files_legacy_collection_map(shadow_collection_id) VALUES($1)', [id]);
    return id;
  }

  // risk: irreversible delete — an empty retired collection goes with its blobs and referencing rows, nothing else.
  it('drops an empty retired collection, its chunk blobs and non-cascading references only', async() => {
    const id = await retired();
    const keep = (await pool.query("INSERT INTO collections(system_area) VALUES('logs') RETURNING id")).rows[0].id;
    await pool.query('INSERT INTO journal(collection_id) VALUES($1)', [keep]);
    await pool.query('INSERT INTO file_chunk_gc(collection_id) VALUES($1)', [id]);
    await cleaner().retire();
    expect(drains).toBe(1);
    expect(deleted.sort()).toEqual(['c1', 'c2']);
    expect((await pool.query('SELECT id FROM collections')).rows.map(row => row.id)).toEqual([keep]);
    expect((await pool.query('SELECT collection_id FROM journal')).rows).toEqual([{ collection_id: keep }]);
    expect(logs).toEqual(['[SullaFiles] removed the retired training-data collection (2 chunk blobs deleted)']);
  });

  // risk: data loss — a retained file or a version reading its chunks keeps the collection and its blobs.
  it('keeps the collection while a file or another version still depends on it', async() => {
    const id = await retired();
    await pool.query('INSERT INTO file_versions(chunk_collection_id) VALUES($1)', [id]);
    await cleaner().retire();
    expect(deleted).toEqual([]);
    expect((await pool.query('SELECT count(*)::int n FROM collections WHERE id=$1', [id])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM journal')).rows[0].n).toBe(1);
    expect(logs).toEqual(['[SullaFiles] retired training-data collection kept for now (files=false pendingChunks=false versions=true)']);
  });

  // risk: a failed blob delete must roll back the row deletes so the next start retries.
  it('rolls back and pauses when a chunk blob delete fails', async() => {
    const id = await retired();
    const failing = new RetiredSystemAreaCleaner(new RetiredSystemAreaRepository(pool), new TransactionRunner(pool, undefined, { slowTransaction: () => undefined }),
      async() => { throw new Error('disk gone') }, async() => undefined, message => logs.push(message));
    await failing.retire();
    expect((await pool.query('SELECT count(*)::int n FROM collections WHERE id=$1', [id])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM file_roots')).rows[0].n).toBe(1);
    expect(logs).toEqual(['[SullaFiles] retired training-data collection cleanup paused: disk gone']);
  });

  // risk: no-op when nothing is retired.
  it('does nothing without a retired collection', async() => {
    await cleaner().retire();
    expect(logs).toEqual([]);
    expect(drains).toBe(0);
  });
});
