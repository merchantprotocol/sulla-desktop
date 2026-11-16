// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Native move/copy publication through LocalFilesManager.applyPathOperations on a real tracked folder,
// real Postgres schema (all migrations) and real chunk store. Requires SULLA_FILES_TEST_DATABASE_URL.
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { LocalFilesManager } from '../src/localManager.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const present = (path:string) => access(path).then(() => true, () => false);

describe.skipIf(!databaseUrl)('native path operation publication (real Postgres + temp folder)', () => {
  const schema = `files_path_publish_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const actor:any = { userId: 'publish-user', deviceId: 'test-device', kind: 'capability' };
  let pool:pg.Pool;
  let temp = '';
  let filesRoot = '';
  let collectionId = '';
  let manager:any;

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA "${ schema }"`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${ schema },public` });
    await migrate(pool);
  });
  afterAll(async() => { await manager?.close(); await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`); await admin.end(); if (temp) await rm(temp, { recursive: true, force: true }) });
  beforeEach(async() => {
    if (manager) await manager.close();
    if (temp) await rm(temp, { recursive: true, force: true });
    temp = await mkdtemp(join(tmpdir(), 'sulla-path-publish-'));
    filesRoot = join(temp, 'files'); const chunkRoot = join(temp, 'chunks');
    await mkdir(join(filesRoot, 'docs'), { recursive: true }); await mkdir(chunkRoot, { recursive: true });
    await writeFile(join(filesRoot, 'docs', 'a.txt'), 'alpha');
    await writeFile(join(filesRoot, 'b.txt'), 'bravo');
    collectionId = randomUUID();
    // Unique explorer_path per collection: collections_explorer_path_owner_org is unique per owner.
    // Separate params: one $n bound to both a uuid and a text column fails with "inconsistent types deduced".
    await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,'publish-user','Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,$2)`, [collectionId, `fixture-${ collectionId }`]);
    const keyring = { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) };
    const rootId = `root-${ collectionId.slice(0, 8) }`;
    const config:any = { chunkRoot, dataRoot: temp, filesRoot, mode: 'desktop', deviceId: 'publish-device', userId: 'publish-user', paused: true, keyring,
      capabilitySigningKey: Buffer.alloc(32, 9), fileRoots: [{ id: rootId, name: 'Files', path: filesRoot, syncMode: 'local', paused: true, exclusions: [], primary: true }] };
    manager = new LocalFilesManager(pool, config);
    manager.rootCollections.set(rootId, collectionId);
    await manager.scanRoot(manager.roots[0]);
  });

  const file = async(path:string) => (await pool.query('SELECT id,path,current_version_id FROM files WHERE collection_id=$1 AND path=$2 AND deleted_at IS NULL', [collectionId, path])).rows[0];
  const snapshot = (row:any) => ({ id: row.id, path: row.path, currentVersionId: row.current_version_id });
  const operations = async() => (await pool.query("SELECT state FROM files_path_operations WHERE plan::text LIKE $1", [`%${ manager.roots[0].id }%`])).rows.map(row => row.state);

  // risk: data accuracy — a copy creates a new tracked file with the same bytes and keeps the original.
  it('copies a file on disk and in Files, and completes the journal', async() => {
    const source = await file('b.txt');
    await manager.applyPathOperations('copy', [{ sourcePath: 'b.txt', targetPath: 'b copy.txt', folder: false, fileSnapshots: [snapshot(source)] }], actor);
    expect(await readFile(join(filesRoot, 'b copy.txt'), 'utf8')).toBe('bravo');
    expect(await readFile(join(filesRoot, 'b.txt'), 'utf8')).toBe('bravo');
    const copy = await file('b copy.txt');
    expect(copy.id).not.toBe(source.id);
    expect((await pool.query('SELECT 1 FROM watched_folder_state WHERE file_id=$1 AND path=$2', [copy.id, 'b copy.txt'])).rowCount).toBe(1);
    expect(await operations()).toEqual(['completed']);
  });

  // risk: data accuracy — a folder move keeps file identity, moves bytes, folder rows and journals a rename.
  it('moves a folder with its files, keeping identity', async() => {
    const source = await file('docs/a.txt');
    await manager.applyPathOperations('move', [{ sourcePath: 'docs', targetPath: 'archive', folder: true, fileSnapshots: [snapshot(source)] }], actor);
    expect(await present(join(filesRoot, 'docs', 'a.txt'))).toBe(false);
    expect(await readFile(join(filesRoot, 'archive', 'a.txt'), 'utf8')).toBe('alpha');
    expect((await file('archive/a.txt')).id).toBe(source.id);
    expect((await pool.query("SELECT op FROM journal WHERE file_id=$1 ORDER BY seq DESC LIMIT 1", [source.id])).rows[0].op).toBe('rename');
    expect(await operations()).toEqual(['completed']);
  });

  // risk: lost update — a stale selection (the file changed since the user picked it) is refused before any byte moves.
  it('refuses a stale snapshot without touching the filesystem', async() => {
    const source = await file('b.txt');
    await expect(manager.applyPathOperations('move', [{ sourcePath: 'b.txt', targetPath: 'c.txt', folder: false, fileSnapshots: [{ ...snapshot(source), currentVersionId: randomUUID() }] }], actor))
      .rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(filesRoot, 'b.txt'), 'utf8')).toBe('bravo');
    expect(await present(join(filesRoot, 'c.txt'))).toBe(false);
    expect(await operations()).toEqual([]);
  });
});
