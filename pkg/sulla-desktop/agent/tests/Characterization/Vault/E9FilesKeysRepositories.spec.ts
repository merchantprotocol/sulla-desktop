// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 Files keys: the repositories and injected collaborators introduced by the
// refactor, exercised directly (PGlite for SQL, a recording client for the
// exact transaction boundary). Runs on the refactored head only.

import type { FilesKeyBundleContext, FilesKeyBundleEnvelope } from '@sulla/vault-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { FilesCloudEscrowService } from '../../../../../../services/sulla-vault/src/filesCloudEscrow';
import { VaultFilesKeyBundleAuthority } from '../../../../../../services/sulla-vault/src/filesKeyBundleAuthority';
import { FilesKeyBundleRoutes, createFilesKeyBundleRouter } from '../../../../../../services/sulla-vault/src/filesKeyBundleRoutes';
import { FilesEscrowKeyCrypto } from '../../../../../../services/sulla-vault/src/filesKeys/FilesEscrowKeyCrypto';
import type { FilesKeyBundleCipher } from '../../../../../../services/sulla-vault/src/filesKeys/FilesKeyBundleCipher';
import { FilesKeyBundlePolicy } from '../../../../../../services/sulla-vault/src/filesKeys/FilesKeyBundlePolicy';
import { PostgresFilesCloudEscrowRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresFilesCloudEscrowRepository';
import { PostgresFilesKeyBundleRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresFilesKeyBundleRepository';
import { E9VaultTestDatabase } from '../../Support/E9Legacy/E9FilesKeysDatabase';

const PRINCIPAL = 'principal-repo';
const USER = '10000000-0000-4000-8000-0000000000e1';
const VAULT = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** Records every statement and release so the transaction boundary can be asserted exactly. */
class RecordingClient {
  readonly log: string[] = [];
  failOn = '';
  async query(sql: string, values?: unknown[]) {
    this.log.push(values ? `${ sql } ${ JSON.stringify(values) }` : sql);
    if (this.failOn && sql.includes(this.failOn)) throw new Error(`failed: ${ this.failOn }`);
    return { rows: [], rowCount: 0 };
  }
  release(): void { this.log.push('release') }
}

class Fixture {
  readonly database = new E9VaultTestDatabase();
  repository!: PostgresFilesKeyBundleRepository;
  escrow!: PostgresFilesCloudEscrowRepository;

  ctx(keyVersion: number, epoch: number, collectionId = 'col-r'): FilesKeyBundleContext {
    return { principalId: PRINCIPAL, collectionId, keyVersion, epoch };
  }

  envelope(context: FilesKeyBundleContext): FilesKeyBundleEnvelope {
    return { version: 1, algorithm: 'x25519+xchacha20-poly1305', purpose: 'authority-custody', context, wrappedKey: { k: `w-${ context.keyVersion }` }, dataKey: { d: 1 }, dedupKey: { d: 2 } } as unknown as FilesKeyBundleEnvelope;
  }

  async setup(): Promise<void> {
    await this.database.setup();
    await this.database.seedUser(USER);
    this.repository = new PostgresFilesKeyBundleRepository(this.database.db);
    this.escrow = new PostgresFilesCloudEscrowRepository(this.database.db);
  }
}

const fx = new Fixture();
beforeAll(async() => { await fx.setup() }, 60_000);
afterAll(async() => { await fx.database.close() });

describe.sequential('E9 Files keys: PostgresFilesKeyBundleRepository', () => {
  it('wraps work in BEGIN, the per-collection advisory lock and COMMIT, then releases', async() => { // risk: custody writes outside the lock or transaction
    const client = new RecordingClient();
    const repository = new PostgresFilesKeyBundleRepository({ connect: async() => client } as unknown as Database);
    await expect(repository.withCollectionLock('p', 'c', async connection => { await connection.query('SELECT 1'); return 'done' })).resolves.toBe('done');
    expect(client.log).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) ["sulla:files:key-bundle:p:c"]', 'SELECT 1', 'COMMIT', 'release']);
  });

  it('rolls back, releases and rethrows when the work or the lock fails', async() => { // risk: half-written custody state
    const client = new RecordingClient();
    const repository = new PostgresFilesKeyBundleRepository({ connect: async() => client } as unknown as Database);
    await expect(repository.withCollectionLock('p', 'c', async() => { throw new Error('work failed') })).rejects.toThrow('work failed');
    expect(client.log.slice(-2)).toEqual(['ROLLBACK', 'release']);
    expect(client.log).not.toContain('COMMIT');
    client.log.length = 0;
    client.failOn = 'pg_advisory_xact_lock';
    let ran = false;
    await expect(repository.withCollectionLock('p', 'c', async() => { ran = true })).rejects.toThrow('failed: pg_advisory_xact_lock');
    expect(ran).toBe(false);
    expect(client.log.slice(-2)).toEqual(['ROLLBACK', 'release']);
  });

  it('stores, finds and advances bundles; not-found reads are undefined', async() => { // risk: lost or misattributed key custody
    const repo = fx.repository;
    await expect(repo.withCollectionLock(PRINCIPAL, 'col-r', connection => repo.findEnvelope(connection, fx.ctx(1, 1)))).resolves.toBeUndefined();
    await expect(repo.withCollectionLock(PRINCIPAL, 'col-r', connection => repo.findCurrentForUpdate(connection, PRINCIPAL, 'col-r'))).resolves.toBeUndefined();
    await expect(repo.findCurrentEnvelope(fx.ctx(1, 1))).resolves.toBeUndefined();

    await repo.withCollectionLock(PRINCIPAL, 'col-r', async connection => {
      await repo.insertEnvelope(connection, { context: fx.ctx(1, 1), authorityKeyId: 'key-1', envelope: fx.envelope(fx.ctx(1, 1)) });
      await repo.upsertCurrent(connection, fx.ctx(1, 1));
    });
    const stored = await repo.withCollectionLock(PRINCIPAL, 'col-r', connection => repo.findEnvelope(connection, fx.ctx(1, 1)));
    expect(stored).toMatchObject({ principal_id: PRINCIPAL, collection_id: 'col-r', authority_key_id: 'key-1', authority_bundle: fx.envelope(fx.ctx(1, 1)) });
    expect(new FilesKeyBundlePolicy().rowContext(stored!)).toEqual(fx.ctx(1, 1));
    await expect(repo.findCurrentEnvelope(fx.ctx(1, 1))).resolves.toMatchObject({ authority_key_id: 'key-1' });

    await repo.withCollectionLock(PRINCIPAL, 'col-r', async connection => {
      await repo.insertEnvelope(connection, { context: fx.ctx(2, 1), authorityKeyId: 'key-1', envelope: fx.envelope(fx.ctx(2, 1)) });
      await repo.upsertCurrent(connection, fx.ctx(2, 1));
    });
    const current = await repo.withCollectionLock(PRINCIPAL, 'col-r', connection => repo.findCurrentForUpdate(connection, PRINCIPAL, 'col-r'));
    expect(new FilesKeyBundlePolicy().rowContext(current!)).toEqual(fx.ctx(2, 1));
    await expect(repo.findCurrentEnvelope(fx.ctx(1, 1))).resolves.toBeUndefined();
    await expect(repo.findCurrentEnvelope(fx.ctx(2, 1))).resolves.toMatchObject({ authority_key_id: 'key-1' });
    await expect(repo.findCurrentEnvelope(fx.ctx(2, 1, 'col-other'))).resolves.toBeUndefined();
  });

  it('rejects a duplicate immutable envelope and rolls back the whole transaction', async() => { // risk: envelope overwrite or partial commit
    const repo = fx.repository;
    await expect(repo.withCollectionLock(PRINCIPAL, 'col-r', async connection => {
      await repo.insertEnvelope(connection, { context: fx.ctx(3, 1), authorityKeyId: 'key-1', envelope: fx.envelope(fx.ctx(3, 1)) });
      await repo.insertEnvelope(connection, { context: fx.ctx(1, 1), authorityKeyId: 'key-2', envelope: fx.envelope(fx.ctx(1, 1)) });
    })).rejects.toThrow();
    await expect(repo.withCollectionLock(PRINCIPAL, 'col-r', connection => repo.findEnvelope(connection, fx.ctx(3, 1)))).resolves.toBeUndefined();
    await expect(repo.withCollectionLock(PRINCIPAL, 'col-r', connection => repo.findEnvelope(connection, fx.ctx(1, 1)))).resolves.toMatchObject({ authority_key_id: 'key-1' });
    await expect(repo.withCollectionLock(PRINCIPAL, 'col-r', connection => repo.upsertCurrent(connection, fx.ctx(9, 9)))).rejects.toThrow();
  });
});

describe.sequential('E9 Files keys: PostgresFilesCloudEscrowRepository', () => {
  it('reports configuration and per-user sync state, undefined when missing', async() => { // risk: escrow for the wrong user vault
    await fx.escrow.ensureSchema();
    await expect(fx.escrow.cloudVaultConfigured()).resolves.toBe(false);
    await expect(fx.escrow.findSyncState(USER)).resolves.toBeUndefined();
    await fx.database.db.query('INSERT INTO cloud_vault_sync_state(owner_user_id,vault_id,epoch) VALUES ($1,$2,$3)', [USER, VAULT, 4]);
    await expect(fx.escrow.cloudVaultConfigured()).resolves.toBe(true);
    await expect(fx.escrow.findSyncState(USER)).resolves.toEqual({ vault_id: VAULT, epoch: 4 });
    await expect(fx.escrow.findSyncState('10000000-0000-4000-8000-0000000000ff')).resolves.toBeUndefined();
  });
});

describe('E9 Files keys: injected collaborators', () => {
  it('never touches the repository when the injected cipher rejects the custody envelope', async() => { // risk: unverified envelope stored
    const touched: string[] = [];
    const repository = new Proxy({}, { get: (_target, name) => () => { touched.push(String(name)); throw new Error('repository touched') } }) as unknown as PostgresFilesKeyBundleRepository;
    const cipher: FilesKeyBundleCipher = { open: async() => { throw new Error('envelope not sealed to this identity') }, rewrapForDevice: async() => { throw new Error('unused') } };
    const policy = new FilesKeyBundlePolicy();
    const identity = { principalId: PRINCIPAL, publicKey: 'cHVi', privateKey: new Uint8Array(32), generation: 1, assertCurrent: () => undefined };
    const authority = new VaultFilesKeyBundleAuthority({} as Database, { withUnlockedIdentity: operation => operation(identity) }, repository, cipher, policy);
    const context = fx.ctx(1, 1);
    await expect(authority.registerBundle({ context, authorityKeyId: policy.authorityKeyId(identity), envelope: fx.envelope(context) })).rejects.toThrow('envelope not sealed to this identity');
    expect(touched).toEqual([]);
  });

  it('escrow service reads state only through its injected repository', async() => { // risk: escrow bypasses the repository boundary
    const calls: string[] = [];
    const repository = {
      ensureSchema: async() => { calls.push('ensureSchema') },
      cloudVaultConfigured: async() => { calls.push('configured'); return false },
      findSyncState: async() => { calls.push('state'); return undefined },
    } as unknown as PostgresFilesCloudEscrowRepository;
    const authority = { withUnlockedUserKey: async() => { throw new Error('unused') }, sullaCloudRequest: async() => { throw new Error('unused') } };
    const service = new FilesCloudEscrowService({} as Database, authority, undefined, undefined, repository, new FilesEscrowKeyCrypto());
    await expect(service.key('5b6c7d8e-9f0a-4b1c-9d2e-3f4a5b6c7d8e', 'AAAA')).rejects.toMatchObject({ code: 'no_cloud_vault', status: 409 });
    expect(calls).toEqual(['ensureSchema', 'configured']);
  });

  it('the routes class and the deprecated router alias enforce the same identity rule', () => { // risk: alias drifts from the class
    const authority = {} as VaultFilesKeyBundleAuthority;
    expect(() => new FilesKeyBundleRoutes(authority, { serviceId: 's', token: 'short' })).toThrow('Vault Files service identity is not configured');
    expect(() => createFilesKeyBundleRouter(authority, { serviceId: 's', token: 'short' })).toThrow('Vault Files service identity is not configured');
    expect(typeof new FilesKeyBundleRoutes(authority, { serviceId: 's', token: 't'.repeat(32) }).router()).toBe('function');
  });
});
