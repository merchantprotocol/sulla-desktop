// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Real Postgres: the path-scoped namespace gate (StoredNamespaceGuard.lock with a path) against the
// real namespace trigger from migration 067, attached to files and file_folders as 027 attaches it.
// Proves concurrent creates in one collection neither serialize nor deadlock, conflicting paths
// still exclude each other, and anything outside a declared scope keeps the exclusive gate.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FilesIdentity } from '../src/auth.js';
import { StoredNamespaceRepository } from '../src/Repositories/StoredNamespaceRepository.js';
import { StoredNamespaceConflict, StoredNamespaceGuard } from '../src/Services/StoredNamespaceGuard.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

/** 'done' or 'failed' if `work` settles within `ms`; 'waiting' if it is still blocked (on a lock). */
async function within(work:Promise<unknown>, ms:number):Promise<'done' | 'failed' | 'waiting'> {
  return Promise.race([work.then(() => 'done' as const, () => 'failed' as const), new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), ms))]);
}

describe.skipIf(!databaseUrl)('stored namespace concurrency (real Postgres, real trigger)', () => {
  const schema = `files_namespace_conc_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${ schema } -c lock_timeout=10s` });
  const guard = new StoredNamespaceGuard(new StoredNamespaceRepository());
  const user = { kind: 'user', userId: 'u1' } as FilesIdentity;
  let collectionId = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query('CREATE TABLE collections(id uuid PRIMARY KEY)');
    await pool.query(migration('026_stored_folders.sql'));
    await pool.query(migration('037_folder_descriptions.sql'));
    await pool.query('CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL)');
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

  /** An open transaction the test commits or rolls back explicitly. */
  async function begin():Promise<pg.PoolClient> { const client = await pool.connect(); await client.query('BEGIN'); return client }
  async function finish(client:pg.PoolClient, commit = true):Promise<void> { try { await client.query(commit ? 'COMMIT' : 'ROLLBACK') } finally { client.release() } }

  /** What a mount create does inside its transaction once the gate is held. */
  async function createFile(client:pg.PoolClient, path:string):Promise<void> {
    await guard.assertFilePath(client, collectionId, path);
    await guard.ensureFileParents(client, collectionId, path, user);
    await client.query('INSERT INTO files(collection_id,path) VALUES($1,$2)', [collectionId, path]);
  }

  // risk: throughput + deadlock — 33378a49d serialized every create (exclusive gate) because the trigger's
  // exclusive key deadlocked two shared holders. Both creates must now hold the gate and insert at once.
  it('lets sibling creates hold the gate and insert together without deadlocking', async() => {
    await pool.query("INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,'docs','u1')", [collectionId]);
    const first = await begin(); const second = await begin();
    try {
      await guard.lock(first, collectionId, 'docs/a.md');
      expect(await within(guard.lock(second, collectionId, 'docs/b.md'), 2_000)).toBe('done');
      await createFile(first, 'docs/a.md');
      expect(await within(createFile(second, 'docs/b.md'), 2_000)).toBe('done');
    } finally { await finish(first); await finish(second) }
    expect((await pool.query('SELECT path FROM files ORDER BY path')).rows.map(row => row.path)).toEqual(['docs/a.md', 'docs/b.md']);
  });

  // risk: namespace corruption — a file and a file beneath it (same prefix) must never both be created.
  it('makes a create under a path wait for a create at that path, then refuses it', async() => {
    const holder = await begin();
    await guard.lock(holder, collectionId, 'notes');
    await createFile(holder, 'notes');
    const waiter = await begin();
    try {
      const below = guard.lock(waiter, collectionId, 'notes/inner.md').then(() => createFile(waiter, 'notes/inner.md'));
      expect(await within(below, 300)).toBe('waiting');
      await finish(holder);
      await expect(below).rejects.toBeInstanceOf(StoredNamespaceConflict);
    } finally { await finish(waiter, false) }
    expect((await pool.query('SELECT path FROM files')).rows.map(row => row.path)).toEqual(['notes']);
  });

  // risk: namespace corruption — the same path created twice at once yields one file.
  it('serializes two creates of the same path and refuses the second', async() => {
    const first = await begin(); const second = await begin();
    try {
      await guard.lock(first, collectionId, 'same/one.md');
      const late = guard.lock(second, collectionId, 'same/one.md').then(() => createFile(second, 'same/one.md'));
      expect(await within(late, 300)).toBe('waiting');
      await createFile(first, 'same/one.md'); await finish(first);
      await expect(late).rejects.toBeInstanceOf(StoredNamespaceConflict);
    } finally { await finish(second, false) }
    expect(Number((await pool.query("SELECT COUNT(*) n FROM files WHERE path='same/one.md'")).rows[0].n)).toBe(1);
  });

  // risk: lost namespace protection — a writer that declared no scope (or whose scope ended with its
  // transaction) still takes the exclusive collection gate in the trigger, so it waits for scoped creates.
  it('keeps the exclusive trigger gate for undeclared writes, and the scope ends with its transaction', async() => {
    const holder = await begin();
    await guard.lock(holder, collectionId, 'held/a.md');
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN'); await guard.lock(writer, collectionId, 'mine/x.md'); await writer.query('COMMIT');
      await writer.query('BEGIN');
      const undeclared = writer.query('INSERT INTO files(collection_id,path) VALUES($1,$2)', [collectionId, 'mine/x.md']);
      expect(await within(undeclared, 300)).toBe('waiting');
      await finish(holder);
      await undeclared; await writer.query('COMMIT');
    } finally { writer.release() }
    expect((await pool.query('SELECT path FROM files')).rows.map(row => row.path)).toEqual(['mine/x.md']);
  });

  // risk: lost updates — a broad namespace edit still excludes scoped creates, and the reverse.
  it('makes a broad namespace lock wait for an open scoped create', async() => {
    const scoped = await begin();
    await guard.lock(scoped, collectionId, 'a/b.md');
    const broad = await begin();
    try {
      const gate = guard.lock(broad, collectionId);
      expect(await within(gate, 300)).toBe('waiting');
      await finish(scoped);
      await gate;
    } finally { await finish(broad) }
  });
});
