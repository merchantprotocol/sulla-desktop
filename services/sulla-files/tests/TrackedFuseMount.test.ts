// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// The experimental FUSE view over a tracked root, driven through LocalFilesManager's public fuse*
// methods on a real temp folder, real Postgres schema (all migrations) and real chunk store.
// Requires SULLA_FILES_TEST_DATABASE_URL.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { LocalFilesManager } from '../src/localManager.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const sha256 = (value:string) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!databaseUrl)('tracked FUSE mount (real Postgres + temp folder)', () => {
  const schema = `files_fuse_mount_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const actor:any = { userId: 'mount-user', deviceId: 'agent-1', kind: 'capability' };
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
    temp = await mkdtemp(join(tmpdir(), 'sulla-fuse-mount-'));
    filesRoot = join(temp, 'files'); const chunkRoot = join(temp, 'chunks');
    await mkdir(filesRoot, { recursive: true }); await mkdir(chunkRoot, { recursive: true });
    await writeFile(join(filesRoot, 'note.md'), 'original');
    collectionId = randomUUID();
    // Unique explorer_path per collection: collections_explorer_path_owner_org is unique per owner.
    await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,'mount-user','Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,$1)`, [collectionId]);
    const keyring = { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) };
    const rootId = `root-${ collectionId.slice(0, 8) }`;
    const config:any = { chunkRoot, dataRoot: temp, filesRoot, mode: 'desktop', deviceId: 'mount-device', userId: 'mount-user', paused: true, keyring,
      capabilitySigningKey: Buffer.alloc(32, 9), fileRoots: [{ id: rootId, name: 'Files', path: filesRoot, syncMode: 'local', paused: true, exclusions: [], primary: true }] };
    manager = new LocalFilesManager(pool, config);
    manager.rootCollections.set(rootId, collectionId);
  });

  // risk: data accuracy — the mount lists exactly the tracked files with their real content hash.
  it('lists tracked files and reads their verified bytes', async() => {
    const [entry] = await manager.fuseSnapshot(collectionId);
    expect(entry).toMatchObject({ path: 'note.md', sourceHash: sha256('original'), size: 8 });
    const read = await manager.fuseRead(entry.id);
    expect(read.bytes.toString()).toBe('original');
    expect((await manager.fuseSnapshot(randomUUID()))).toEqual([]);
  });

  // risk: data integrity — bytes that no longer match the index are never served as the tracked version.
  it('refuses to read a file that changed on disk since indexing', async() => {
    const [entry] = await manager.fuseSnapshot(collectionId);
    await writeFile(join(filesRoot, 'note.md'), 'edited outside Files');
    await expect(manager.fuseRead(entry.id)).rejects.toMatchObject({ status: 409 });
  });

  // risk: data accuracy — a write against the current version replaces the bytes and records a new version.
  it('writes through to the source and records a new Files version', async() => {
    const [entry] = await manager.fuseSnapshot(collectionId);
    const written = await manager.fuseWrite(entry.id, entry.versionId, entry.sourceHash, Buffer.from('updated by agent'), actor);
    expect(written).toMatchObject({ id: entry.id, sourceHash: sha256('updated by agent') });
    expect(written.versionId).not.toBe(entry.versionId);
    expect(await readFile(join(filesRoot, 'note.md'), 'utf8')).toBe('updated by agent');
  });

  // risk: lost update — a write against a stale version never overwrites; the agent's bytes become a visible conflicted copy.
  it('keeps a stale write as a conflicted copy and leaves the source untouched', async() => {
    const [entry] = await manager.fuseSnapshot(collectionId);
    await expect(manager.fuseWrite(entry.id, randomUUID(), entry.sourceHash, Buffer.from('stale agent edit'), actor))
      .rejects.toMatchObject({ status: 409, conflictPath: expect.stringContaining('conflicted copy') });
    expect(await readFile(join(filesRoot, 'note.md'), 'utf8')).toBe('original');
    const conflict = (await readdir(filesRoot)).find(name => name.includes('conflicted copy'));
    expect(conflict).toBeDefined();
    expect(await readFile(join(filesRoot, conflict!), 'utf8')).toBe('stale agent edit');
  });
});
