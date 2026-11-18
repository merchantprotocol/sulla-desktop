// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Real Postgres, real namespace trigger (migration 067): the path-scoped locks the FUSE replace and
// rmdir routes now take. Replace used to take the whole collection exclusively, so `mv a b` over an
// existing file stalled every create in the collection; rmdir did the same. These tests pin the
// scoped behaviour: creates elsewhere keep running, crossed replaces cannot deadlock, and an rmdir
// racing a create inside the folder always ends in a consistent state.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FilesIdentity } from '../src/auth.js';
import { FuseWriteRepository } from '../src/Repositories/FuseWriteRepository.js';
import { StoredNamespaceRepository } from '../src/Repositories/StoredNamespaceRepository.js';
import { StoredNamespaceGuard } from '../src/Services/StoredNamespaceGuard.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

/** 'done' or 'failed' if `work` settles within `ms`; 'waiting' if it is still blocked (on a lock). */
async function within(work:Promise<unknown>, ms:number):Promise<'done' | 'failed' | 'waiting'> {
  return Promise.race([work.then(() => 'done' as const, () => 'failed' as const), new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), ms))]);
}

describe.skipIf(!databaseUrl)('FUSE replace and rmdir locks (real Postgres, real trigger)', () => {
  const schema = `files_fuse_locks_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${ schema } -c lock_timeout=10s` });
  const guard = new StoredNamespaceGuard(new StoredNamespaceRepository());
  const writes = new FuseWriteRepository(pool);
  const user = { kind: 'user', userId: 'u1' } as FilesIdentity;
  let collectionId = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query('CREATE TABLE collections(id uuid PRIMARY KEY)');
    await pool.query(migration('026_stored_folders.sql'));
    await pool.query(migration('037_folder_descriptions.sql'));
    await pool.query('CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL,deleted_at timestamptz)');
    await pool.query(migration('067_scoped_namespace_trigger.sql'));
    await pool.query(`CREATE TRIGGER files_guard_operation_namespace BEFORE INSERT OR UPDATE OF path,collection_id ON files
      FOR EACH ROW EXECUTE FUNCTION files_guard_operation_namespace()`);
    await pool.query(`CREATE TRIGGER folders_guard_operation_namespace BEFORE INSERT OR UPDATE OF path,collection_id ON file_folders
      FOR EACH ROW EXECUTE FUNCTION files_guard_operation_namespace()`);
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE collections, files, file_folders');
    collectionId = randomUUID();
    await pool.query('INSERT INTO collections(id) VALUES($1)', [collectionId]);
  });

  async function begin():Promise<pg.PoolClient> { const client = await pool.connect(); await client.query('BEGIN'); return client }
  async function finish(client:pg.PoolClient, commit = true):Promise<void> { try { await client.query(commit ? 'COMMIT' : 'ROLLBACK') } finally { client.release() } }

  /** What a mount create does inside its transaction once the gate is held. */
  async function createFile(client:pg.PoolClient, path:string):Promise<void> {
    await guard.assertFilePath(client, collectionId, path);
    await guard.ensureFileParents(client, collectionId, path, user);
    await client.query('INSERT INTO files(collection_id,path) VALUES($1,$2)', [collectionId, path]);
  }

  /** The replace route's locked section: lock target and source paths, then trash the source row. */
  async function replaceOver(client:pg.PoolClient, targetPath:string, sourcePath:string):Promise<void> {
    await guard.lockPaths(client, collectionId, [targetPath, sourcePath]);
    await client.query('UPDATE files SET deleted_at=NOW() WHERE collection_id=$1 AND path=$2', [collectionId, sourcePath]);
  }

  /** The rmdir route's locked section: lock the folder, refuse when a live file sits under it, else delete the tree. */
  async function rmdir(client:pg.PoolClient, folderPath:string):Promise<'removed' | 'not-empty'> {
    await guard.lock(client, collectionId, folderPath);
    if (await writes.folderHasLiveFiles(client, collectionId, folderPath)) return 'not-empty';
    await writes.deleteFolderTree(client, collectionId, folderPath);
    return 'removed';
  }

  async function seedFile(path:string):Promise<void> {
    await pool.query('INSERT INTO files(collection_id,path) VALUES($1,$2)', [collectionId, path]);
  }

  // risk: availability / data integrity — replacing b with a must not stall an unrelated create in the
  // same collection. Before the scoped lock, replace took the collection gate exclusively and this hung.
  it('lets a create elsewhere in the collection run while a replace over an existing file is open', async() => {
    await seedFile('a.md'); await seedFile('b.md');
    const replace = await begin(); const create = await begin();
    try {
      await replaceOver(replace, 'b.md', 'a.md');
      expect(await within(guard.lock(create, collectionId, 'c.md').then(() => createFile(create, 'c.md')), 2_000)).toBe('done');
    } finally { await finish(replace); await finish(create) }
    expect((await pool.query('SELECT path FROM files WHERE deleted_at IS NULL ORDER BY path')).rows.map(row => row.path)).toEqual(['b.md', 'c.md']);
  });

  // risk: deadlock — two replaces that cross (a over b and b over a) must queue, not deadlock. Each takes
  // its paths in sorted order, so the second waits on the first shared key and then runs to completion.
  it('queues crossed replaces on the same path order instead of deadlocking', async() => {
    await seedFile('a.md'); await seedFile('b.md');
    const first = await begin(); const second = await begin();
    try {
      await guard.lockPaths(first, collectionId, ['a.md', 'b.md']);
      await first.query("UPDATE files SET deleted_at=NOW() WHERE collection_id=$1 AND path='b.md'", [collectionId]);
      const crossed = replaceOver(second, 'a.md', 'b.md');
      expect(await within(crossed, 300)).toBe('waiting');
      await finish(first);
      expect(await within(crossed, 5_000)).toBe('done');
    } finally { await finish(second) }
    expect((await pool.query('SELECT path FROM files WHERE deleted_at IS NULL')).rows.map(row => row.path)).toEqual(['a.md']);
  });

  // risk: orphan file — an rmdir that races a create inside the folder must not leave a file whose
  // folder is missing, and must not delete a folder that a committed child still needs.
  it('refuses the rmdir when a create inside the folder commits first (folder and file both kept)', async() => {
    await pool.query("INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,'d','u1')", [collectionId]);
    const create = await begin(); const remove = await begin();
    try {
      await guard.lock(create, collectionId, 'd/a.txt');
      await createFile(create, 'd/a.txt');
      const removal = rmdir(remove, 'd');
      expect(await within(removal, 300)).toBe('waiting');
      await finish(create);
      await expect(removal).resolves.toBe('not-empty');
    } finally { await finish(remove, false) }
    expect((await pool.query("SELECT path FROM file_folders WHERE collection_id=$1 AND path='d'", [collectionId])).rowCount).toBe(1);
    expect((await pool.query('SELECT path FROM files')).rows.map(row => row.path)).toEqual(['d/a.txt']);
  });

  // risk: orphan file — when the rmdir commits first, the create that waited for it must recreate the
  // folder it needs, so the file never lands in a folder that no longer exists.
  it('lets the create that waited on an rmdir re-create its parent folder (no orphan file)', async() => {
    await pool.query("INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,'d','u1')", [collectionId]);
    const remove = await begin(); const create = await begin();
    try {
      expect(await rmdir(remove, 'd')).toBe('removed');
      const late = guard.lock(create, collectionId, 'd/a.txt').then(() => createFile(create, 'd/a.txt'));
      expect(await within(late, 300)).toBe('waiting');
      await finish(remove);
      expect(await within(late, 5_000)).toBe('done');
    } finally { await finish(create) }
    const files = (await pool.query('SELECT path FROM files')).rows.map(row => row.path);
    const folders = (await pool.query('SELECT path FROM file_folders WHERE collection_id=$1', [collectionId])).rows.map(row => row.path);
    expect(files).toEqual(['d/a.txt']);
    expect(folders).toContain('d');
  });
});
