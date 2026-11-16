// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real Postgres: the protected-file check (ProtectedFileRepository + ProtectedFilePolicy) and the
// collection access lookup (CollectionAccessRepository + CollectionAccessResolver). Own schema,
// real 030 system-area migration.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CollectionAccessResolver } from '../src/acl.js';
import type { FilesIdentity } from '../src/auth.js';
import { CollectionAccessRepository } from '../src/Repositories/CollectionAccessRepository.js';
import { ProtectedFileRepository } from '../src/Repositories/ProtectedFileRepository.js';
import { ProtectedFilePolicy } from '../src/Services/ProtectedFilePolicy.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');

describe.skipIf(!databaseUrl)('protected files and collection access (real Postgres)', () => {
  const schema = `files_protected_spec_${ randomUUID().replaceAll('-', '') }`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${ schema }` });
  const policy = new ProtectedFilePolicy(new ProtectedFileRepository(pool));
  const access = new CollectionAccessResolver(new CollectionAccessRepository(pool));
  const actor = { kind: 'user', userId: 'u1' } as FilesIdentity;
  let logs = ''; let home = '';

  beforeAll(async() => {
    await pool.query(`CREATE SCHEMA ${ schema }`);
    await pool.query(`CREATE TABLE collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),published boolean NOT NULL DEFAULT TRUE,
      legacy_source boolean NOT NULL DEFAULT FALSE,name text)`);
    await pool.query(migration('030_system_areas.sql'));
    await pool.query('CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL,path text NOT NULL)');
    await pool.query('CREATE TABLE files_protected_files(file_id uuid PRIMARY KEY)');
  });
  afterAll(async() => { await pool.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await pool.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE collections, files, files_protected_files');
    logs = (await pool.query("INSERT INTO collections(system_area,name) VALUES('logs','Logs') RETURNING id")).rows[0].id;
    home = (await pool.query("INSERT INTO collections(name) VALUES('Files') RETURNING id")).rows[0].id;
  });
  const file = async(collectionId:string, path:string) => ({ id: (await pool.query('INSERT INTO files(collection_id,path) VALUES($1,$2) RETURNING id', [collectionId, path])).rows[0].id as string, path });

  // risk: secret exposure — key, wallet and vault paths and marked files are refused with 403.
  it('refuses protected paths and files marked protected', async() => {
    for (const path of ['keys/master.key', 'My Wallets/seed.txt', 'vault/x.json', 'a\\vaults\\b']) {
      await expect(policy.assertUnprotected(await file(home, path))).rejects.toMatchObject({ status: 403, message: 'Protected system file' });
    }
    const marked = await file(home, 'notes/plain.md');
    await pool.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [marked.id]);
    await expect(policy.assertUnprotected(marked)).rejects.toMatchObject({ status: 403 });
    await expect(policy.assertUnprotected(await file(home, 'notes/vaulted-ideas.md'))).resolves.toBeUndefined();
  });

  // risk: audit visibility — a vault audit log is readable only where it really lives (the Logs area).
  it('allows an audit log path only inside the Logs system area', async() => {
    await expect(policy.assertUnprotected(await file(logs, 'audit/vault/s1.jsonl'))).resolves.toBeUndefined();
    await expect(policy.assertUnprotected(await file(home, 'audit/vault/s1.jsonl'))).rejects.toMatchObject({ status: 403 });
  });

  // risk: permissions — only published, non-legacy collections resolve; others are 404.
  it('resolves published collections and refuses unpublished, legacy or unknown ones', async() => {
    expect(await access.resolve(actor, home)).toMatchObject({ role: 'manage', collection: { id: home, name: 'Files' } });
    const hidden = (await pool.query('INSERT INTO collections(published) VALUES(FALSE) RETURNING id')).rows[0].id;
    const legacy = (await pool.query('INSERT INTO collections(legacy_source) VALUES(TRUE) RETURNING id')).rows[0].id;
    for (const id of [hidden, legacy, randomUUID()]) await expect(access.resolve(actor, id)).rejects.toMatchObject({ status: 404 });
  });
});
