// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresLocalAuthorityRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresLocalAuthorityRepository';
import { LegacyVaultDatabase } from '../../Support/LegacyVaultHarness';

class LocalAuthorityRepositoryFixture {
  static readonly OWNER = '7e900000-0000-4000-8000-0000000000aa';
  readonly database = new LegacyVaultDatabase();

  get repository(): PostgresLocalAuthorityRepository { return new PostgresLocalAuthorityRepository(this.database.db) }

  async open(): Promise<void> {
    await this.database.open();
    await this.database.db.query(`INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
      VALUES ($1,'owner@example.test',$2,$3,'pk','{}'::jsonb,'{}'::jsonb,'{}'::jsonb)`, [LocalAuthorityRepositoryFixture.OWNER, Buffer.from('s'), Buffer.from('v')]);
  }

  async state(integrationId: string, accountId: string): Promise<void> {
    await this.database.db.query('INSERT INTO local_integration_state(owner_user_id,integration_id,active_account_id) VALUES ($1,$2,$3)', [LocalAuthorityRepositoryFixture.OWNER, integrationId, accountId]);
  }

  async label(): Promise<string | null> {
    const result = await this.database.db.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [LocalAuthorityRepositoryFixture.OWNER]);
    return result.rows[0]?.email ?? null;
  }
}

const fixture = new LocalAuthorityRepositoryFixture();
beforeAll(() => fixture.open());
afterAll(() => fixture.database.close());

describe.sequential('PostgresLocalAuthorityRepository', () => {
  it('reads the active account per integration and the prior Sulla Cloud account', async() => {
    // risk: tenant isolation — a Mac signed in to one Cloud account must not be claimed by another.
    await fixture.state('sulla-cloud', 'cloud-user-1');
    await fixture.state('openai', 'work');
    const repository = fixture.repository;
    expect((await repository.findPriorSullaCloudAccount<{ active_account_id: string }>(LocalAuthorityRepositoryFixture.OWNER)).rows).toEqual([{ active_account_id: 'cloud-user-1' }]);
    expect((await repository.findActiveAccount<{ active_account_id: string }>(LocalAuthorityRepositoryFixture.OWNER, 'openai')).rows).toEqual([{ active_account_id: 'work' }]);
    expect((await repository.findActiveAccount(LocalAuthorityRepositoryFixture.OWNER, 'github')).rows).toEqual([]);
    expect((await repository.findPriorSullaCloudAccount('7e900000-0000-4000-8000-0000000000bb')).rows).toEqual([]);
  });

  it('commits a successful unit and rolls back a failed one, surfacing the original error', async() => {
    // risk: data accuracy — a failed vault write must leave no partial rows behind.
    const repository = fixture.repository;
    await repository.transaction(client => client.query('UPDATE users SET email=$1 WHERE id=$2', ['committed@example.test', LocalAuthorityRepositoryFixture.OWNER]));
    expect(await fixture.label()).toBe('committed@example.test');
    const failure = new Error('write failed');
    await expect(repository.transaction(async client => {
      await client.query('UPDATE users SET email=$1 WHERE id=$2', ['rolled-back@example.test', LocalAuthorityRepositoryFixture.OWNER]);
      throw failure;
    })).rejects.toBe(failure);
    expect(await fixture.label()).toBe('committed@example.test');
  });

  it('runs explicit begin/lock/commit and rollback steps on the caller client', async() => {
    // risk: data accuracy — the legacy import and backup restore keep their own transaction boundaries.
    const repository = fixture.repository;
    const client = await fixture.database.db.connect();
    try {
      await repository.begin(client);
      await repository.lockLegacyImport(client);
      await client.query('UPDATE users SET email=$1 WHERE id=$2', ['explicit@example.test', LocalAuthorityRepositoryFixture.OWNER]);
      await repository.rollback(client);
      expect(await fixture.label()).toBe('committed@example.test');
      await repository.begin(client);
      await client.query('UPDATE users SET email=$1 WHERE id=$2', ['explicit@example.test', LocalAuthorityRepositoryFixture.OWNER]);
      await repository.commit(client);
      expect(await fixture.label()).toBe('explicit@example.test');
      await repository.beginReadOnly(client);
      await expect(client.query('UPDATE users SET email=$1 WHERE id=$2', ['read-only@example.test', LocalAuthorityRepositoryFixture.OWNER])).rejects.toThrow();
      await repository.rollback(client);
    } finally {
      client.release();
    }
    expect(await fixture.label()).toBe('explicit@example.test');
  });
});
