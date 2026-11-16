// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Real-Postgres specs for the legacy preflight/import repositories' business rules. Point
// SULLA_FILES_TEST_DATABASE_URL at a throwaway database; each run creates and drops its own schema.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../src/db.js';
import { LegacyImportControlRepository } from '../src/Repositories/LegacyImportControlRepository.js';
import { LegacyImportReceiptRepository } from '../src/Repositories/LegacyImportReceiptRepository.js';
import { LegacyImportStagingRepository } from '../src/Repositories/LegacyImportStagingRepository.js';
import { LegacyPreflightRepository } from '../src/Repositories/LegacyPreflightRepository.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('legacy import repositories (real Postgres)', () => {
  const schema = `files_legacy_repo_spec_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool;

  async function collection(options:{ legacy?:boolean; external?:boolean; key?:boolean } = {}):Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state,legacy_source,explorer_path)
      VALUES($1,'u1','c','knowledge','desktop-only',$2,'{}',$3,$4,$5)`, [id, options.external ? '{"v":1}' : '{}', options.external ? 'legacy-external-data' : 'native', options.legacy ?? false, id]);
    if (options.key) await pool.query(`INSERT INTO files_collection_keys(collection_id,data_key,dedup_key) VALUES($1,'{}','{}')`, [id]);
    return id;
  }
  async function file(collectionId:string, path:string):Promise<string> {
    return (await pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id) VALUES($1,$2,'user','u1') RETURNING id`, [collectionId, path])).rows[0].id;
  }
  async function inTransaction<T>(work:(client:pg.PoolClient) => Promise<T>):Promise<T> {
    const control = new LegacyImportControlRepository(); const client = await pool.connect();
    try { await control.begin(client); const result = await work(client); await control.commit(client); return result } catch (error) { await control.rollback(client); throw error } finally { client.release() }
  }

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA ${ schema }`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${ schema },public` });
    await migrate(pool);
  }, 30_000);
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await admin.end() });
  beforeEach(async() => { await pool.query('TRUNCATE collections, files_legacy_imports, files_legacy_preflight, manifests CASCADE') });

  // risk: data exposure — once containment is required, a later "clear" check must never downgrade it.
  it('records preflight without downgrading containment or replacing the first prefix', async() => {
    const repository = new LegacyPreflightRepository(pool);
    await repository.record(true, 'chunks');
    await repository.record(false, 'Chunks-other');
    expect((await pool.query('SELECT state,protected_prefix,reason FROM files_legacy_preflight')).rows[0])
      .toEqual({ state: 'secure-import-required', protected_prefix: 'chunks', reason: 'retired-external-chunk-store' });
    expect(await repository.previous()).toEqual({ state: 'secure-import-required', protected_prefix: 'chunks' });
  });

  // risk: misclassification — keyless collections with external key material are external; keyed ones stay native.
  it('classifies only keyless collections with retired key material as external', async() => {
    const keyed = await collection({ key: true });
    const external = await collection();
    await pool.query(`UPDATE collections SET encrypted_data_key='{"v":1}' WHERE id IN ($1,$2)`, [keyed, external]);
    const repository = new LegacyPreflightRepository(pool);
    await repository.classifyExternalCollections();
    expect(await repository.externalCollectionIds()).toEqual([external]);
  });

  // risk: data exposure — watched files under the retired tree are protected; siblings sharing the prefix are not.
  it('protects watched files at or below the prefix, case-insensitively', async() => {
    const id = await collection({ key: true });
    const paths = ['CHUNKS', 'chunks/ab/x', 'chunks-old/y', 'docs/chunks'];
    for (const path of paths) {
      const fileId = await file(id, path);
      await pool.query(`INSERT INTO watched_folder_state(root_id,collection_id,path,file_id,content_hash,size,mtime_ms) VALUES('default',$1,$2,$3,'h',1,1)`, [id, path, fileId]);
    }
    await new LegacyPreflightRepository(pool).protectWatchedPrefix('chunks');
    const protectedPaths = (await pool.query('SELECT f.path FROM files_protected_files p JOIN files f ON f.id=p.file_id ORDER BY f.path')).rows.map(row => row.path);
    expect(protectedPaths).toEqual(['CHUNKS', 'chunks/ab/x']);
  });

  // risk: partial import — a collection whose versions use a legacy chunk collection must join the import set.
  it('expands the legacy source set across shared chunk collections until stable', async() => {
    const legacy = await collection({ legacy: true, external: true });
    const borrower = await collection();
    const unrelated = await collection();
    const fileId = await file(borrower, 'shared.md');
    await pool.query(`INSERT INTO file_versions(file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id) VALUES($1,$2,0,'user','u1','d')`, [fileId, legacy]);
    const staging = new LegacyImportStagingRepository();
    const sources = await inTransaction(async client => {
      let expanded:number | null = 1; while (expanded) expanded = await staging.expandSources(client);
      return (await staging.lockSourceCollections(client)).map(row => row.id);
    });
    expect(sources.sort()).toEqual([legacy, borrower].sort());
    expect(sources).not.toContain(unrelated);
  });

  // risk: duplicated data — staging maps are stable: re-running never creates a second shadow or file map.
  it('creates one shadow collection and keeps file maps stable across repeated staging', async() => {
    const legacy = await collection({ legacy: true, external: true });
    const fileId = await file(legacy, 'a.md');
    const staging = new LegacyImportStagingRepository();
    const stage = () => inTransaction(async client => {
      await staging.markStaging(client);
      if (!await staging.findCollectionMapping(client, legacy)) await staging.createShadowCollection(client, legacy, randomUUID(), { v: 1 } as any, { v: 2 } as any);
      await staging.mapFiles(client); await staging.mapVersions(client);
      return { mappings: await staging.listCollectionMappings(client), files: (await client.query('SELECT shadow_file_id::text FROM files_legacy_file_map WHERE source_file_id=$1', [fileId])).rows };
    });
    const first = await stage(); const second = await stage();
    expect(second).toEqual(first);
    expect(first.mappings).toEqual([{ source_collection_id: legacy, shadow_collection_id: expect.any(String), published_at: null }]);
    const shadow = (await pool.query('SELECT compatibility_state,legacy_source,published FROM collections WHERE id=$1', [first.mappings[0].shadow_collection_id])).rows[0];
    expect(shadow).toEqual({ compatibility_state: 'native', legacy_source: false, published: false });
    expect((await pool.query('SELECT state FROM files_legacy_imports')).rows[0].state).toBe('staging');
  });

  // risk: data exposure — quarantine unpublishes and protects every non-native source and records why.
  it('quarantines external sources and leaves native collections published', async() => {
    const external = await collection({ external: true });
    const native = await collection({ key: true });
    const externalFile = await file(external, 'x.md'); const nativeFile = await file(native, 'y.md');
    const receipt = new LegacyImportReceiptRepository();
    await inTransaction(client => receipt.quarantineSources(client));
    const rows = (await pool.query('SELECT id::text,legacy_source,published FROM collections ORDER BY id')).rows;
    expect(rows.find(row => row.id === external)).toEqual({ id: external, legacy_source: true, published: false });
    expect(rows.find(row => row.id === native)).toEqual({ id: native, legacy_source: false, published: true });
    const protectedIds = (await pool.query('SELECT file_id::text FROM files_protected_files')).rows.map(row => row.file_id);
    expect(protectedIds).toContain(externalFile); expect(protectedIds).not.toContain(nativeFile);
    expect((await pool.query('SELECT state,reason FROM files_legacy_preflight')).rows[0]).toEqual({ state: 'secure-import-required', reason: 'quarantined-import-validation' });
    expect(await inTransaction(client => receipt.isCompleted(client))).toBe(false);
  });
});
