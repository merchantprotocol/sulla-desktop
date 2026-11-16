// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real Postgres: system-area provisioning (SystemAreaRepository) and system-area mirroring
// (SystemAreaIngestRepository). Own schema, real 030 system-area migration.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { TransactionRunner } from '../src/FilesTransaction.js';
import { SystemAreaIngestRepository } from '../src/Repositories/SystemAreaIngestRepository.js';
import { SystemAreaRepository } from '../src/Repositories/SystemAreaRepository.js';
import { SystemAreaMirror } from '../src/Services/SystemAreaMirror.js';
import { SystemAreaProvisioner } from '../src/Services/SystemAreaProvisioner.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('system areas (real Postgres)', () => {
  const schema = `files_sysarea_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${ schema }` });
  const runner = new TransactionRunner(pool, undefined, { slowTransaction: () => undefined });
  const provisioner = new SystemAreaProvisioner(runner, new SystemAreaRepository());
  const mirror = new SystemAreaMirror(runner, new SystemAreaIngestRepository());
  const keyring = { unlocked: true, created: [] as string[], async create(id:string) { this.created.push(id); return { data: { k: 'd' }, dedup: { k: 'x' } } } };
  const config = (overrides:Partial<Config> = {}) => ({ userId: 'u1', orgId: undefined, keyring, ...overrides }) as unknown as Config;

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query(`CREATE TABLE collections(id uuid PRIMARY KEY,org_id text,owner_user_id text NOT NULL,name text NOT NULL,kind text,home text,
      encrypted_data_key jsonb,dedup_key_ciphertext jsonb,retention_policy jsonb,explorer_path text,published boolean NOT NULL DEFAULT TRUE,
      legacy_source boolean NOT NULL DEFAULT FALSE,is_default boolean NOT NULL DEFAULT FALSE,created_at timestamptz NOT NULL DEFAULT NOW())`);
    await pool.query(migration('030_system_areas.sql'));
    await pool.query('CREATE TABLE collection_acl(collection_id uuid,principal_type text,principal_id text,role text)');
    await pool.query(`CREATE TABLE file_folders(collection_id uuid NOT NULL,path text NOT NULL,created_by_type text,created_by_id text,description text,
      PRIMARY KEY(collection_id,path))`);
    await pool.query(`CREATE TABLE file_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),manifest_hash text)`);
    await pool.query(`CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL,current_version_id uuid,
      deleted_at timestamptz,extracted_at timestamptz,extraction_status text,extraction_reason_code text,extraction_reason text,UNIQUE(collection_id,path))`);
    await pool.query('CREATE TABLE file_index_jobs(file_id uuid,version_id uuid)');
    await pool.query('CREATE TABLE file_search_text(file_id uuid)');
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE collections, collection_acl, file_folders, file_versions, files, file_index_jobs, file_search_text');
    keyring.created = [];
  });

  // risk: data placement — first start creates Logs and the deterministic home with their folders and keys.
  it('creates the Logs and home collections with keys and every standard folder', async() => {
    await provisioner.ensure(config());
    const rows = (await pool.query('SELECT id,name,system_area,explorer_path,encrypted_data_key FROM collections ORDER BY name')).rows;
    expect(rows.map(row => [row.name, row.system_area, row.explorer_path])).toEqual([['Files', null, ''], ['Logs', 'logs', 'Logs']]);
    const home = rows.find(row => row.name === 'Files');
    expect(home.id).toBe(SystemAreaProvisioner.collectionIdFor('u1'));
    expect(home.encrypted_data_key).toEqual({ k: 'd' });
    expect(keyring.created.sort()).toEqual(rows.map(row => row.id).sort());
    const folders = (await pool.query('SELECT path,description FROM file_folders WHERE collection_id=$1 ORDER BY path', [home.id])).rows;
    expect(folders.map(row => row.path)).toContain('Use Cases');
    expect(folders.find(row => row.path === 'Memory/sulla')?.description).toBe('Memories written by Sulla agents and services.');
  });

  // risk: duplicates on restart — a second run reuses collections and fills only a missing description.
  it('is idempotent and fills a missing folder description without duplicating rows', async() => {
    await provisioner.ensure(config());
    const home = SystemAreaProvisioner.collectionIdFor('u1');
    await pool.query("UPDATE file_folders SET description=NULL WHERE collection_id=$1 AND path='Memory'", [home]);
    const before = (await pool.query('SELECT count(*)::int n FROM file_folders')).rows[0].n;
    await provisioner.ensure(config());
    expect((await pool.query('SELECT count(*)::int n FROM collections')).rows[0].n).toBe(2);
    expect((await pool.query('SELECT count(*)::int n FROM file_folders')).rows[0].n).toBe(before);
    expect(keyring.created).toHaveLength(2);
    expect((await pool.query("SELECT description FROM file_folders WHERE collection_id=$1 AND path='Memory'", [home])).rows[0].description).toMatch(/^Durable agent memory/);
  });

  // risk: security — nothing is provisioned while the keyring is locked; Logs is never writable.
  it('refuses to provision with a locked keyring and keeps Logs read-only', async() => {
    await expect(provisioner.ensure(config({ keyring: { unlocked: false } as never }))).rejects.toThrow('must be unlocked');
    expect((await pool.query('SELECT count(*)::int n FROM collections')).rows[0].n).toBe(0);
    expect(() => SystemAreaProvisioner.assertWritable('logs')).toThrow(expect.objectContaining({ status: 403, code: 'EROFS' }));
    expect(() => SystemAreaProvisioner.assertWritable(null)).not.toThrow();
  });

  // risk: version churn — an unchanged manifest is a no-op; a change writes a version and stays unindexed.
  it('skips an unchanged system file and writes an unindexed version when it changed', async() => {
    const collectionId = randomUUID();
    const insertVersion = async(client:{ query:(sql:string, values?:unknown[]) => Promise<{ rows:any[] }> }, existing?:{ id:string }) => {
      const version = (await client.query('INSERT INTO file_versions(manifest_hash) VALUES($1) RETURNING id', [hash])).rows[0].id;
      const id = existing
        ? (await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1 RETURNING id', [existing.id, version])).rows[0].id
        : (await client.query('INSERT INTO files(collection_id,path,current_version_id) VALUES($1,$2,$3) RETURNING id', [collectionId, 'skills/a.md', version])).rows[0].id;
      await client.query('INSERT INTO file_index_jobs(file_id,version_id) VALUES($1,$2)', [id, version]);
      await client.query('INSERT INTO file_search_text(file_id) VALUES($1)', [id]);
      inserted++;
      return { id, current_version_id: version };
    };
    let inserted = 0; let hash = 'm1';
    const steps = { lockNamespace: async() => undefined, insertVersion };
    const input = { collectionId, path: 'skills/a.md', manifestHash: 'm1', skipSearchIndex: true };
    const first = await mirror.mirror(input, steps);
    expect(first.unchanged).toBe(false);
    expect((await mirror.mirror(input, steps)).unchanged).toBe(true);
    expect(inserted).toBe(1);
    hash = 'm2';
    const second = await mirror.mirror({ ...input, manifestHash: 'm2' }, steps);
    expect(second).toMatchObject({ id: first.id, unchanged: false });
    expect((await pool.query('SELECT count(*)::int n FROM file_index_jobs')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM file_search_text')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT extraction_status,extraction_reason_code FROM files WHERE id=$1', [first.id])).rows[0])
      .toEqual({ extraction_status: 'unsupported', extraction_reason_code: 'system_area_unindexed' });
  });
});
