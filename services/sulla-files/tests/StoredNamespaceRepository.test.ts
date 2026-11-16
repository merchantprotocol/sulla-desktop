// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real Postgres: stored-namespace slot checks, folder creation and advisory-lock exclusion
// (StoredNamespaceRepository + StoredNamespaceGuard). Own schema, real 026 stored-folders and 037 folder-description migrations.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FilesIdentity } from '../src/auth.js';
import { StoredNamespaceRepository } from '../src/Repositories/StoredNamespaceRepository.js';
import { StoredNamespaceConflict, StoredNamespaceGuard } from '../src/Services/StoredNamespaceGuard.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('stored namespace (real Postgres)', () => {
  const schema = `files_namespace_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${ schema }` });
  const guard = new StoredNamespaceGuard(new StoredNamespaceRepository());
  const user = { kind: 'user', userId: 'u1' } as FilesIdentity;
  let collectionId = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query('CREATE TABLE collections(id uuid PRIMARY KEY)');
    await pool.query(migration('026_stored_folders.sql'));
    await pool.query(migration('037_folder_descriptions.sql'));
    await pool.query(migration('067_scoped_namespace_trigger.sql'));
    await pool.query('CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL)');
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE collections, files, file_folders');
    collectionId = randomUUID();
    await pool.query('INSERT INTO collections(id) VALUES($1)', [collectionId]);
  });

  async function inTransaction<T>(work:(client:pg.PoolClient) => Promise<T>):Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  const folders = async() => (await pool.query('SELECT path,created_by_type,description FROM file_folders ORDER BY path')).rows;

  // risk: namespace corruption — a file may not sit on, above or below an existing file or on a folder.
  it('rejects file paths that clash with a file prefix or an existing folder', async() => {
    await pool.query("INSERT INTO files(collection_id,path) VALUES($1,'a/b.md'),($1,'top')", [collectionId]);
    await pool.query("INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,'dir','u1')", [collectionId]);
    await inTransaction(async client => {
      await expect(guard.assertFilePath(client, collectionId, 'a/b.md/c.md')).rejects.toBeInstanceOf(StoredNamespaceConflict);
      await expect(guard.assertFilePath(client, collectionId, 'top')).rejects.toMatchObject({ status: 409 });
      await expect(guard.assertFilePath(client, collectionId, 'dir')).rejects.toThrow('A folder already exists at dir.');
      await expect(guard.assertFilePath(client, collectionId, 'a')).rejects.toThrow('A file already occupies a/b.md');
      await expect(guard.assertFolderPath(client, collectionId, 'top/sub')).rejects.toThrow('so top/sub cannot be a folder');
      const same = (await client.query("SELECT id FROM files WHERE path='top'")).rows[0].id;
      await expect(guard.assertFilePath(client, collectionId, 'top', same)).resolves.toBeUndefined();
      await expect(guard.assertFilePath(client, randomUUID(), 'top')).resolves.toBeUndefined();
    });
  });

  // risk: folder rows — only missing parents are created, shallowest first, with the agent's description.
  it('creates only missing parent folders and attributes agent-created ones', async() => {
    await pool.query("INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,'x','u1')", [collectionId]);
    await inTransaction(client => guard.ensureFileParents(client, collectionId, 'x/y/z/file.md', { kind: 'capability', userId: 'u1', agentId: 'bot' } as FilesIdentity));
    await inTransaction(client => guard.ensureFolder(client, collectionId, 'x/y/w', user));
    const rows = await folders();
    expect(rows.map(row => row.path)).toEqual(['x', 'x/y', 'x/y/w', 'x/y/z']);
    expect(rows.find(row => row.path === 'x/y')).toMatchObject({ created_by_type: 'agent-or-device', description: expect.stringMatching(/^Created by bot on \d{4}-\d{2}-\d{2} — needs description$/) });
    expect(rows.find(row => row.path === 'x/y/w')).toMatchObject({ created_by_type: 'user', description: null });
  });

  // risk: lost updates — a broad namespace edit excludes a scoped create in the same collection until it commits.
  it('blocks a scoped create while a broad namespace lock is held', async() => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await guard.lock(holder, collectionId);
      let acquired = false;
      const waiter = inTransaction(async client => { await guard.lock(client, collectionId, 'a/b.md'); acquired = true });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(acquired).toBe(false);
      await holder.query('COMMIT');
      await waiter;
      expect(acquired).toBe(true);
    } finally { holder.release() }
  });
});
