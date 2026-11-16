// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Runs Vault principal adoption against real Postgres (SULLA_FILES_TEST_DATABASE_URL).
// Own random schema; applies the real 007/011/017 migrations.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { VaultPrincipalRepository } from '../src/Repositories/VaultPrincipalRepository.js';
import { VaultPrincipalAdoption } from '../src/vaultPrincipal.js';
import { KeyTablesSchema } from './support/KeyTablesSchema.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const FOREIGN = 'Existing Files collections belong to another principal; secure migration is required';

describe.skipIf(!databaseUrl)('Vault principal adoption (real Postgres)', () => {
  const schema = new KeyTablesSchema(databaseUrl ?? '');
  const adoption = new VaultPrincipalAdoption(schema.pool);
  const owners = async() => (await schema.pool.query('SELECT id::text,owner_user_id FROM collections ORDER BY id')).rows;
  const links = async() => (await schema.pool.query('SELECT id,owner_user_id FROM file_share_links ORDER BY id')).rows;

  beforeAll(async() => { await schema.create() });
  afterAll(async() => { await schema.drop() });
  beforeEach(async() => { await schema.reset() });

  it('moves sentinel collections and their share links to the Vault principal', async() => {
    // risk: data accuracy/ownership — every sentinel-owned collection and link must follow the principal.
    const a = await schema.collection('desktop-user');
    const b = await schema.collection('desktop-user');
    const file = (await schema.pool.query("INSERT INTO files(collection_id,path) VALUES($1,'/x') RETURNING id", [b])).rows[0].id;
    await schema.pool.query("INSERT INTO file_share_links(id,owner_user_id,collection_id) VALUES('l1','desktop-user',$1)", [a]);
    await schema.pool.query("INSERT INTO file_share_links(id,owner_user_id,file_id) VALUES('l2','desktop-user',$1)", [file]);
    await schema.pool.query("INSERT INTO file_share_links(id,owner_user_id,collection_id) VALUES('l3','someone-else',$1)", [a]);
    const config = { userId: 'desktop-user' };
    await adoption.adopt(config, 'principal-1');
    expect(config.userId).toBe('principal-1');
    expect((await owners()).every(row => row.owner_user_id === 'principal-1')).toBe(true);
    expect(await links()).toEqual([{ id: 'l1', owner_user_id: 'principal-1' }, { id: 'l2', owner_user_id: 'principal-1' }, { id: 'l3', owner_user_id: 'someone-else' }]);
  });

  it('is a no-op when the principal is already adopted', async() => {
    // risk: idempotency — restarting must not rewrite ownership.
    await schema.collection('principal-1');
    const config = { userId: 'principal-1' };
    await adoption.adopt(config, 'principal-1');
    expect(config.userId).toBe('principal-1');
    expect((await owners())[0].owner_user_id).toBe('principal-1');
  });

  it('refuses when collections belong only to a different principal and changes nothing', async() => {
    // risk: tenant isolation — another principal's store must never be silently taken over.
    await schema.collection('someone-else');
    const config = { userId: 'desktop-user' };
    await expect(adoption.adopt(config, 'principal-1')).rejects.toThrow(FOREIGN);
    expect(config.userId).toBe('desktop-user');
    expect((await owners())[0].owner_user_id).toBe('someone-else');
  });

  it('refuses when the current user is not the sentinel', async() => {
    // risk: permissions — only the first-run sentinel may adopt a Vault principal.
    const config = { userId: 'principal-0' };
    await expect(adoption.adopt(config, 'principal-1')).rejects.toThrow(FOREIGN);
    expect(config.userId).toBe('principal-0');
  });

  it('rolls back when a sentinel collection already has a custody bundle for another principal', async() => {
    // risk: security — a bundle sealed for someone else proves the data is not ours to adopt.
    const id = await schema.collection('desktop-user');
    await schema.pool.query(`INSERT INTO files_collection_key_bundles(collection_id,principal_id,key_version,key_epoch,authority_key_id,authority_bundle)
      VALUES($1,'someone-else',1,1,'a','{}'::jsonb)`, [id]);
    await schema.pool.query("INSERT INTO file_share_links(id,owner_user_id,collection_id) VALUES('l1','desktop-user',$1)", [id]);
    const config = { userId: 'desktop-user' };
    await expect(adoption.adopt(config, 'principal-1')).rejects.toThrow(FOREIGN);
    expect(config.userId).toBe('desktop-user');
    expect((await owners())[0].owner_user_id).toBe('desktop-user');
    expect((await links())[0].owner_user_id).toBe('desktop-user');
  });

  it('repository detects foreign bundles only for the listed collections', async() => {
    // risk: tenant isolation — the probe must be scoped to the supplied collections.
    const repository = new VaultPrincipalRepository(schema.pool);
    const mine = await schema.collection('desktop-user'); const other = await schema.collection('x');
    await schema.pool.query(`INSERT INTO files_collection_key_bundles(collection_id,principal_id,key_version,key_epoch,authority_key_id,authority_bundle)
      VALUES($1,'someone-else',1,1,'a','{}'::jsonb),($2,'principal-1',1,1,'a','{}'::jsonb)`, [other, mine]);
    expect(await repository.hasBundleForOtherPrincipal([mine], 'principal-1')).toBe(false);
    expect(await repository.hasBundleForOtherPrincipal([mine, other], 'principal-1')).toBe(true);
  });
});
