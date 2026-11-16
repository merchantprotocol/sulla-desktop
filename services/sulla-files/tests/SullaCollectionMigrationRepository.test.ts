// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real Postgres: the Sulla-collection merge and stray-Docs cleanup (SullaCollectionMigrationRepository
// with SullaCollectionMigrator / StrayDocsTrasher). Own schema, real 030 system-area migration.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { TransactionRunner } from '../src/FilesTransaction.js';
import { SullaCollectionMigrationRepository } from '../src/Repositories/SullaCollectionMigrationRepository.js';
import { StrayDocsTrasher } from '../src/Services/StrayDocsTrasher.js';
import { SullaCollectionMigrator } from '../src/Services/SullaCollectionMigrator.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('Sulla collection migration (real Postgres)', () => {
  const schema = `files_sullamig_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${ schema }` });
  const repository = new SullaCollectionMigrationRepository(pool);
  const runner = new TransactionRunner(pool, undefined, { slowTransaction: () => undefined });
  const migrator = new SullaCollectionMigrator(repository, runner);
  const trasher = new StrayDocsTrasher(repository, runner);
  const config = { userId: 'u1', deviceId: 'mac-1' } as Config;
  let source = ''; let home = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query(`CREATE TABLE collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id text NOT NULL DEFAULT 'u1',published boolean NOT NULL DEFAULT TRUE,
      legacy_source boolean NOT NULL DEFAULT FALSE,is_default boolean NOT NULL DEFAULT FALSE,explorer_path text,created_at timestamptz NOT NULL DEFAULT NOW())`);
    await pool.query(migration('030_system_areas.sql'));
    await pool.query('CREATE TABLE file_roots(id text,collection_id uuid)');
    await pool.query('CREATE TABLE collection_acl(collection_id uuid,principal_type text,principal_id text,role text)');
    await pool.query(`CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL,current_version_id uuid,
      deleted_at timestamptz,updated_at timestamptz,created_by_type text NOT NULL DEFAULT 'user',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(collection_id,path))`);
    await pool.query('CREATE TABLE file_folders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL,UNIQUE(collection_id,path))');
    await pool.query(`CREATE TABLE file_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),file_id uuid,chunk_collection_id uuid,parent_version_id uuid,manifest_hash text,
      size bigint,deleted boolean,created_by_type text,created_by_id text,message text,device_id text,base_server_version_id uuid)`);
    await pool.query('CREATE TABLE journal(collection_id uuid,file_id uuid,version_id uuid,op text)');
    await pool.query('CREATE TABLE audit_log(who_type text,who_id text,device_or_run_id text,file_id uuid,version_id uuid,action text,details jsonb)');
    await pool.query('CREATE TABLE watched_folder_state(file_id uuid)');
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query('DROP TABLE IF EXISTS sulla_collection_migration_paths');
    await pool.query('TRUNCATE collections, file_roots, collection_acl, files, file_folders, file_versions, journal, audit_log, watched_folder_state');
    source = (await pool.query("INSERT INTO collections(system_area,explorer_path) VALUES('sulla','Sulla') RETURNING id")).rows[0].id;
    home = (await pool.query("INSERT INTO collections(explorer_path,is_default) VALUES('',TRUE) RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO file_roots(id,collection_id) VALUES('default',$1)", [home]);
  });

  const file = async(collectionId:string, path:string) =>
    (await pool.query('INSERT INTO files(collection_id,path,current_version_id) VALUES($1,$2,gen_random_uuid()) RETURNING id', [collectionId, path])).rows[0].id as string;
  const paths = async(collectionId:string, table = 'files') =>
    (await pool.query(`SELECT path FROM ${ table } WHERE collection_id=$1`, [collectionId])).rows.map(row => row.path as string).sort();

  // risk: data loss — every folder and file moves to home; a clash renames instead of overwriting.
  it('moves folders and files into home, renaming collisions and children of renamed folders', async() => {
    await pool.query("INSERT INTO file_folders(collection_id,path) VALUES($1,'Notes'),($2,'Notes'),($1,'Plans')", [source, home]);
    await file(home, 'Notes');
    await file(source, 'Notes/a.md'); await file(source, 'Plans/b.md');
    await file(home, 'todo.md'); await file(source, 'todo.md');
    expect(await migrator.migrate(config)).toEqual({ moved: 3, collisions: 2 });
    expect(await paths(source)).toEqual([]);
    expect(await paths(home)).toEqual(['Notes', 'Notes (migrated)/a.md', 'Plans/b.md', 'todo (migrated).md', 'todo.md']);
    expect(await paths(home, 'file_folders')).toEqual(['Notes', 'Notes (migrated)', 'Plans']);
    expect((await pool.query("SELECT count(*)::int n FROM journal WHERE op='rename' AND collection_id=$1", [home])).rows[0].n).toBe(3);
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='sulla-collection-migration'")).rows[0].n).toBe(3);
    expect((await pool.query('SELECT explorer_path FROM collections WHERE id=$1', [source])).rows[0].explorer_path).toBe('.sulla-retired');
  });

  // risk: duplicate moves on restart — a finished migration is a no-op.
  it('is idempotent', async() => {
    await file(source, 'x.md');
    await migrator.migrate(config);
    expect(await migrator.migrate(config)).toEqual({ moved: 0, collisions: 0 });
    expect(await paths(home)).toEqual(['x.md']);
    expect((await pool.query('SELECT count(*)::int n FROM journal')).rows[0].n).toBe(1);
  });

  // risk: tracked Mac folders — only Docs/ copies with no watched-folder state go to Trash, once.
  it('trashes stray bundled Docs in tracked roots exactly once and leaves real ones alone', async() => {
    const tracked = (await pool.query("INSERT INTO collections(explorer_path) VALUES('Mac') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO file_roots(id,collection_id) VALUES('mac',$1)", [tracked]);
    const stray = await file(tracked, 'Docs/guide.md');
    const watched = await file(tracked, 'Docs/mine.md');
    await pool.query('INSERT INTO watched_folder_state(file_id) VALUES($1)', [watched]);
    await file(home, 'Docs/guide.md');
    expect(await trasher.trash(config)).toBe(1);
    expect(await trasher.trash(config)).toBe(0);
    const row = (await pool.query('SELECT deleted_at,current_version_id FROM files WHERE id=$1', [stray])).rows[0];
    expect(row.deleted_at).not.toBeNull();
    const version = (await pool.query('SELECT deleted,device_id,chunk_collection_id FROM file_versions WHERE id=$1', [row.current_version_id])).rows[0];
    expect(version).toEqual({ deleted: true, device_id: 'mac-1', chunk_collection_id: tracked });
    expect((await pool.query("SELECT file_id FROM journal WHERE op='delete'")).rows).toEqual([{ file_id: stray }]);
    expect((await pool.query('SELECT count(*)::int n FROM files WHERE deleted_at IS NOT NULL')).rows[0].n).toBe(1);
  });
});
