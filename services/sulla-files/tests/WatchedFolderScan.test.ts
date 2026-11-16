// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Characterizes the native (Mac) tracked-root scan: disk walk, ingest, rename detection, soft delete
// and the mass-disappearance guard. Real LocalFilesManager, real Postgres schema (all migrations),
// real temp folder and chunk store. Requires SULLA_FILES_TEST_DATABASE_URL.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { LocalFilesManager } from '../src/localManager.js';
import { TransactionScope } from '../src/TransactionScope.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const sha256 = (value:string) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!databaseUrl)('watched folder scan and ingest (real Postgres + temp folder)', () => {
  const schema = `files_watch_scan_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool;
  let temp = '';
  let filesRoot = '';
  let collectionId = '';
  let manager:any;

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA "${ schema }"`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${ schema },public` });
    await migrate(pool);
    TransactionScope.guardPool(pool);
  });
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`); await admin.end() });
  beforeEach(async() => {
    if (manager) await manager.close();
    if (temp) await rm(temp, { recursive: true, force: true });
    temp = await mkdtemp(join(tmpdir(), 'sulla-watch-scan-'));
    filesRoot = join(temp, 'files'); const chunkRoot = join(temp, 'chunks');
    await mkdir(filesRoot, { recursive: true }); await mkdir(chunkRoot, { recursive: true });
    collectionId = randomUUID();
    // Unique explorer_path per collection: collections_explorer_path_owner_org is unique per owner.
    await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,'scan-user','Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,$1)`, [collectionId]);
    const keyring = { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) };
    const config:any = { chunkRoot, dataRoot: temp, filesRoot, mode: 'desktop', deviceId: 'scan-device', userId: 'scan-user', paused: true, keyring,
      capabilitySigningKey: Buffer.alloc(32, 9), fileRoots: [{ id: `root-${ collectionId.slice(0, 8) }`, name: 'Files', path: filesRoot, syncMode: 'local', paused: true, exclusions: ['*.skip'], primary: true }] };
    manager = new LocalFilesManager(pool, config);
    manager.rootCollections.set(config.fileRoots[0].id, collectionId);
  });

  const scan = () => manager.scanRoot(manager.roots[0]);
  const live = async() => (await pool.query('SELECT f.id,f.path,f.deleted_at,f.current_version_id FROM files f WHERE f.collection_id=$1 ORDER BY f.path', [collectionId])).rows;
  const watched = async() => (await pool.query('SELECT path,file_id,content_hash FROM watched_folder_state WHERE collection_id=$1 ORDER BY path', [collectionId])).rows;
  const journal = async(fileId:string) => (await pool.query('SELECT op FROM journal WHERE file_id=$1 ORDER BY seq', [fileId])).rows.map(row => row.op);

  // risk: data accuracy — every visible file on disk becomes exactly one Files record with its real hash; ignored ones never do.
  it('ingests new files, skips ignored and protected paths, and records their content hash', async() => {
    await mkdir(join(filesRoot, 'docs'), { recursive: true });
    await writeFile(join(filesRoot, 'docs', 'a.md'), 'alpha');
    await writeFile(join(filesRoot, 'empty.txt'), '');
    await writeFile(join(filesRoot, 'x.skip'), 'excluded by root');
    await writeFile(join(filesRoot, 'notes.tmp'), 'default ignore');
    await scan();
    expect((await live()).map(row => row.path)).toEqual(['docs/a.md', 'empty.txt']);
    expect(await watched()).toEqual([
      expect.objectContaining({ path: 'docs/a.md', content_hash: sha256('alpha') }),
      expect.objectContaining({ path: 'empty.txt', content_hash: sha256('') }),
    ]);
    const version = (await pool.query(`SELECT v.size,m.chunk_ids FROM files f JOIN file_versions v ON v.id=f.current_version_id JOIN manifests m ON m.hash=v.manifest_hash
      WHERE f.collection_id=$1 AND f.path='docs/a.md'`, [collectionId])).rows[0];
    expect(Number(version.size)).toBe(5);
    // #2356 integrity: every manifest chunk has its chunks row.
    const missing = await pool.query('SELECT 1 FROM jsonb_array_elements_text($1::jsonb) AS t(chunk_id) WHERE NOT EXISTS(SELECT 1 FROM chunks c WHERE c.collection_id=$2 AND c.id=t.chunk_id)', [JSON.stringify(version.chunk_ids), collectionId]);
    expect(missing.rowCount).toBe(0);
  });

  // risk: version history — an edit creates a new version on the same file; an unchanged rescan creates none.
  it('versions an edited file and leaves an unchanged file alone', async() => {
    await writeFile(join(filesRoot, 'a.txt'), 'one');
    await scan();
    const [first] = await live();
    await scan();
    expect((await live())[0].current_version_id).toBe(first.current_version_id);
    await writeFile(join(filesRoot, 'a.txt'), 'two!');
    await new Promise(resolve => setTimeout(resolve, 5));
    await scan();
    const [edited] = await live();
    expect(edited.id).toBe(first.id);
    expect(edited.current_version_id).not.toBe(first.current_version_id);
    expect(await journal(first.id)).toEqual(['put', 'put']);
  });

  // risk: data loss — a moved file keeps its identity (rename), and a removed file goes to Trash, not oblivion.
  it('detects a rename by content and soft-deletes a removed file', async() => {
    await writeFile(join(filesRoot, 'old.txt'), 'same bytes');
    await writeFile(join(filesRoot, 'gone.txt'), 'bye');
    await writeFile(join(filesRoot, 'stay.txt'), 'kept');
    await scan();
    const before = Object.fromEntries((await live()).map(row => [row.path, row.id]));
    await rename(join(filesRoot, 'old.txt'), join(filesRoot, 'new.txt'));
    await unlink(join(filesRoot, 'gone.txt'));
    await scan();
    const after = await live();
    expect(after.find(row => row.path === 'new.txt')?.id).toBe(before['old.txt']);
    expect(await journal(before['old.txt'])).toEqual(['put', 'rename']);
    expect(after.find(row => row.id === before['gone.txt'])?.deleted_at).not.toBeNull();
    expect(await journal(before['gone.txt'])).toEqual(['put', 'delete']);
    expect((await watched()).map(row => row.path)).toEqual(['new.txt', 'stay.txt']);
  });

  // risk: data loss — an empty (unmounted/unavailable) folder must never trash everything Files indexed.
  it('suspends deletion when the whole tracked folder disappears', async() => {
    await writeFile(join(filesRoot, 'a.txt'), 'a');
    await scan();
    await unlink(join(filesRoot, 'a.txt'));
    await expect(scan()).rejects.toThrow('Folder availability changed unexpectedly');
    expect((await live())[0].deleted_at).toBeNull();
  });
});
