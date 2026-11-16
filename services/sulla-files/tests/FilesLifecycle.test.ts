// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real-Postgres characterization of Files unlock/bootstrap (FilesLifecycle + FilesKeyStateRepository).
// Point SULLA_FILES_TEST_DATABASE_URL at a throwaway Postgres, e.g.
//   docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine
// Each run creates and drops its own schema and applies the real 007/011 key-state migrations.
// The keyring and service hooks are fakes; the key-state SQL and bootstrap ordering are real.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FilesLifecycle } from '../src/lifecycle.js';
import { FilesMasterKeyRejectedError, type FilesKeyring } from '../src/keyring.js';
import type { Config } from '../src/config.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');
const master = Buffer.alloc(32, 7);

/** Records what the lifecycle asked of the keyring; `reject` makes unlock refuse the master. */
class FakeKeyring {
  opened = false; closed = 0; reject = false;
  get unlocked() { return this.opened }
  async unlock() { if (this.reject) throw new FilesMasterKeyRejectedError(); this.opened = true }
  close() { this.opened = false; this.closed++ }
}

describe.skipIf(!databaseUrl)('Files lifecycle unlock (real Postgres)', () => {
  const schema = `files_unlock_spec_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${ schema }`, max: 2 });
  let keyring:FakeKeyring; let calls:string[];
  const hooks = () => ({
    initialize: async() => { calls.push('initialize') },
    stop: async() => { calls.push('stop') },
    recover: async(key:Buffer) => { calls.push(`recover:${ key.equals(master) }`); return 1 },
  });
  const lifecycle = (config:Partial<Config> = {}) => new FilesLifecycle(pool, { capabilitySigningKey: 'signing', caseInsensitiveRoot: false, ...config } as Config, keyring as unknown as FilesKeyring, hooks());

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA ${ schema }`);
    await pool.query(`CREATE TABLE collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id text NOT NULL DEFAULT 'owner-1',published boolean NOT NULL DEFAULT TRUE,
      legacy_source boolean NOT NULL DEFAULT FALSE,compatibility_state text NOT NULL DEFAULT 'native',encrypted_data_key jsonb NOT NULL DEFAULT '{}',dedup_key_ciphertext jsonb NOT NULL DEFAULT '{}')`);
    await pool.query('CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),path text NOT NULL)');
    await pool.query('CREATE TABLE manifests(hash text PRIMARY KEY,chunk_ids jsonb NOT NULL)');
    await pool.query('CREATE TABLE file_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),file_id uuid,chunk_collection_id uuid,manifest_hash text)');
    await pool.query('CREATE TABLE chunks(collection_id uuid NOT NULL,id text NOT NULL,PRIMARY KEY(collection_id,id))');
    await pool.query(migration('007_keychain_keys.sql'));
    await pool.query(migration('011_key_bundle_recovery.sql'));
  });
  afterAll(async() => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await admin.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE files_collection_key_bundles, files_collection_keys, files_key_state, chunks, file_versions, manifests, files, collections CASCADE');
    keyring = new FakeKeyring(); calls = [];
  });

  const keyState = () => pool.query(`INSERT INTO files_key_state(id,verifier) VALUES(TRUE,'{}')`);
  /** A published native collection whose owner bundle exists: the state recovery can rebuild from. */
  async function recoverableCollection() {
    const id = (await pool.query('INSERT INTO collections DEFAULT VALUES RETURNING id')).rows[0].id;
    await pool.query(`INSERT INTO files_collection_keys(collection_id,key_origin,data_key,dedup_key) VALUES($1,'random','{}','{}')`, [id]);
    await pool.query(`INSERT INTO files_collection_key_bundles(collection_id,principal_id,key_version,key_epoch,authority_key_id,authority_bundle) VALUES($1,'owner-1',1,1,'authority','{}')`, [id]);
    return id;
  }

  // risk: data loss — a fresh master must never be created over encrypted data a new key can't open.
  it('chooses create-new only for an empty store and refuses it when encrypted data exists', async() => {
    expect(await lifecycle().disposition(false)).toBe('create-new');
    expect(await lifecycle().disposition(true)).toBe('existing');
    const collectionId = (await pool.query('INSERT INTO collections DEFAULT VALUES RETURNING id')).rows[0].id;
    await pool.query("INSERT INTO chunks(collection_id,id) VALUES($1,'c1')", [collectionId]);
    await expect(lifecycle().disposition(false)).rejects.toMatchObject({ code: 'FILES_MASTER_STATE_INCOMPLETE', status: 409 });
  });

  // risk: data loss — recovery is offered only when every published key has its owner bundle.
  it('requires the stored master unless recovery state is complete', async() => {
    await keyState();
    await expect(lifecycle().disposition(false)).rejects.toMatchObject({ code: 'FILES_MASTER_BLOB_REQUIRED' });
    const collectionId = await recoverableCollection();
    expect(await lifecycle().disposition(false)).toBe('recover');
    await pool.query('DELETE FROM files_collection_key_bundles WHERE collection_id=$1', [collectionId]);
    await expect(lifecycle().disposition(false)).rejects.toMatchObject({ code: 'FILES_MASTER_BLOB_REQUIRED' });
  });

  // risk: sign-in — the right master unlocks Files and runs initialization once.
  it('unlocks with the stored master', async() => {
    await keyState();
    const files = lifecycle();
    expect(await files.bootstrap({ masterKey: master, legacyMasterKeys: [] }, 'existing', files.generation)).toEqual({ state: 'unlocked', legacyImport: 'clear', recovered: false });
    expect(files.status()).toEqual({ state: 'unlocked', legacyImport: 'clear' });
    expect(files.ready).toBe(true);
    expect(calls).toEqual(['initialize']);
  });

  // risk: data loss — a rejected master preserves data, locks the keyring and reports a 409, never recovery.
  it('rejects a wrong master when recovery is not possible', async() => {
    await keyState(); keyring.reject = true;
    const files = lifecycle({ legacyPreflight: { state: 'clear' } });
    await expect(files.bootstrap({ masterKey: master, legacyMasterKeys: [] }, 'existing', files.generation))
      .rejects.toMatchObject({ code: 'FILES_MASTER_KEY_REJECTED', status: 409 });
    expect(files.status()).toEqual({ state: 'error', legacyImport: 'clear', failure: { code: 'FILES_MASTER_KEY_REJECTED', stage: 'keyring' } });
    expect(keyring.closed).toBeGreaterThan(0);
    expect(calls).toEqual(['stop']);
  });

  // risk: data loss — with complete recovery state a rejected master recovers instead of failing.
  it('recovers when the master is rejected but recovery state is complete', async() => {
    await keyState(); await recoverableCollection(); keyring.reject = true;
    const files = lifecycle({ legacyPreflight: { state: 'clear' } });
    expect(await files.bootstrap({ masterKey: master, legacyMasterKeys: [] }, 'existing', files.generation)).toMatchObject({ state: 'unlocked', recovered: true });
    expect(calls).toEqual(['recover:true', 'initialize']);
  });

  // risk: data loss — bootstrap re-checks key state and refuses when it changed since disposition.
  it('refuses create-new when key state appeared during bootstrap', async() => {
    await keyState();
    const files = lifecycle();
    await expect(files.bootstrap({ masterKey: master, legacyMasterKeys: [] }, 'create-new', files.generation))
      .rejects.toMatchObject({ code: 'FILES_BOOTSTRAP_STATE_CHANGED', status: 409 });
    expect(files.status().state).toBe('error');
  });
});
