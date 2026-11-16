// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Tracked-root registry on the real Files schema (all migrations): home collection creation,
// root registration/detach custody, settings and brokered scan state. Requires SULLA_FILES_TEST_DATABASE_URL.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { collectionIdFor } from '../src/systemAreas.js';
import { TransactionScope } from '../src/TransactionScope.js';
import { TrackedRootCatalog } from '../src/TrackedRootCatalog.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('tracked root catalog (real Postgres)', () => {
  const schema = `files_root_catalog_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool;
  let userId = '';
  let keysCreated = 0;
  let roots:any[];
  let rootCollections:Map<string, string>;
  let rescans = 0;
  let catalog:TrackedRootCatalog;

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA "${ schema }"`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${ schema },public` });
    await migrate(pool);
    TransactionScope.guardPool(pool);
  });
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`); await admin.end() });
  beforeEach(() => {
    userId = `user-${ randomUUID().slice(0, 8) }`; keysCreated = 0; rescans = 0;
    roots = [
      { id: 'default', name: 'Sulla Files', path: '/tmp/a', syncMode: 'local', paused: false, exclusions: [], primary: true },
      { id: `work-${ userId }`, name: 'Work', path: `/tmp/b-${ userId }`, syncMode: 'local', paused: true, exclusions: ['*.log'] },
    ];
    rootCollections = new Map();
    const keyring = { create: async(id:string, client:pg.PoolClient) => {
      keysCreated++;
      await client.query('INSERT INTO files_collection_keys(collection_id,data_key,dedup_key) VALUES($1,$2,$3)', [id, '{"k":"d"}', '{"k":"x"}']);
      return { data: { k: 'd' }, dedup: { k: 'x' } };
    } };
    catalog = new TrackedRootCatalog(pool, { userId, keyring } as any, roots, rootCollections);
  });
  /**
   * Home collections are published with explorer_path '' and collections_explorer_path_owner_org is
   * unique per owner, so only one root per owner can be created with the default path. Seed the
   * secondary root's home collection with its own explorer_path; the catalog must reuse it.
   */
  async function seedWorkCollection():Promise<string> {
    const id = collectionIdFor(userId, roots[1].id);
    await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,$2,'Work','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,$3)`, [id, userId, `fixture-${ id }`]);
    return id;
  }
  const rows = async() => (await pool.query("SELECT id,enabled,state,paused,exclusions FROM file_roots WHERE id=ANY($1::text[]) ORDER BY id", [[...roots.map(root => root.id), 'gone-' + userId]])).rows;

  // risk: data accuracy — each root gets exactly one home collection with keys, reused on every restart.
  it('creates each home collection once, with keys, and reuses it', async() => {
    const work = await seedWorkCollection();
    const primary = await catalog.registerConfigured();
    expect(primary).toBe(rootCollections.get('default'));
    expect(rootCollections.get(roots[1].id)).toBe(work);
    expect(keysCreated).toBe(1);
    const collections = (await pool.query('SELECT id,name,home,encrypted_data_key FROM collections WHERE owner_user_id=$1 ORDER BY name', [userId])).rows;
    expect(collections.map(row => row.name)).toEqual(['Files', 'Work']);
    expect(collections.find(row => row.name === 'Files')).toMatchObject({ home: 'desktop-only', encrypted_data_key: { k: 'd' } });
    await catalog.registerConfigured();
    expect(keysCreated).toBe(1);
    expect(await rows()).toEqual([
      expect.objectContaining({ id: 'default', enabled: true, state: 'idle' }),
      expect.objectContaining({ id: roots[1].id, enabled: true, state: 'paused', exclusions: ['*.log'] }),
    ]);
  });

  // risk: data loss — detaching forgets scan custody but never deletes files; the default root can't be detached.
  it('detaches a root, forgets its watched state and keeps its files', async() => {
    await seedWorkCollection();
    await catalog.registerConfigured();
    const work = roots[1].id; const collectionId = rootCollections.get(work)!;
    const file = (await pool.query("INSERT INTO files(collection_id,path,created_by_type,created_by_id) VALUES($1,'a.txt','user',$2) RETURNING id", [collectionId, userId])).rows[0].id;
    await pool.query("INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id) VALUES($1,'a.txt',$2,'h',1,1,$3)", [collectionId, file, work]);
    await expect(catalog.detach('default')).rejects.toMatchObject({ status: 409 });
    await catalog.detach(work);
    expect((await pool.query('SELECT 1 FROM watched_folder_state WHERE root_id=$1', [work])).rowCount).toBe(0);
    expect((await pool.query('SELECT deleted_at FROM files WHERE id=$1', [file])).rows[0].deleted_at).toBeNull();
    expect(roots.map(root => root.id)).toEqual(['default']);
    expect(rootCollections.has(work)).toBe(false);
    await expect(catalog.detach(work)).rejects.toMatchObject({ status: 404 });
    expect((await catalog.list()).map(root => root.id)).toEqual(['default']);
  });

  // risk: settings — configuring a root persists it, updates the live config, and rescans only when unpaused.
  it('configures settings and rescans when a root is resumed', async() => {
    await seedWorkCollection();
    await catalog.registerConfigured();
    const work = roots[1].id;
    const paused = await catalog.configure(work, { exclusions: ['*.tmp'] }, async() => { rescans++ });
    expect(paused).toMatchObject({ state: 'paused', exclusions: ['*.tmp'] });
    expect(rescans).toBe(0);
    const resumed = await catalog.configure(work, { paused: false }, async() => { rescans++ });
    expect(resumed).toMatchObject({ paused: false, state: 'idle', exclusions: ['*.tmp'] });
    expect(roots[1]).toMatchObject({ paused: false, exclusions: ['*.tmp'] });
    expect(rescans).toBe(1);
    await expect(catalog.configure(work, { syncMode: 'server' }, async() => undefined)).rejects.toMatchObject({ status: 409 });
    await expect(catalog.configure('missing', {}, async() => undefined)).rejects.toMatchObject({ status: 409 });
  });

  // risk: validation — brokered roots accept only safe ids/exclusions; scan state needs a registered root.
  it('attaches a brokered root and tracks its scan state', async() => {
    await expect(catalog.attachBrokered({ id: '../etc', name: 'x', syncMode: 'local', paused: false, exclusions: [] })).rejects.toMatchObject({ status: 400 });
    const id = `gone-${ userId }`;
    const { root } = await catalog.attachBrokered({ id, name: 'Host', syncMode: 'local', paused: false, exclusions: [] });
    expect(root).toMatchObject({ id, state: 'scanning', collectionId: rootCollections.get(id) });
    expect((await catalog.brokeredScanState(id, { state: 'idle', pendingFiles: 0 })).state).toBe('idle');
    expect((await catalog.brokeredScanState(id, { state: 'error', lastError: 'disk gone' }))).toMatchObject({ state: 'error', lastError: 'disk gone' });
    await expect(catalog.brokeredScanState('nope', { state: 'idle' })).rejects.toMatchObject({ status: 404 });
    await expect(catalog.brokeredScanState(id, { state: 'idle', pendingFiles: -1 })).rejects.toMatchObject({ status: 400 });
  });
});
