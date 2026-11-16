// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E10 (vault transaction follow-up): backup import and the legacy credential migration run through
// PgTransactionRunner, so a failed ROLLBACK never masks the real error and the possibly broken client
// is released WITH the rollback error (pg destroys it instead of pooling an open transaction and its
// advisory lock). Device-enrollment commit re-checks the lock generation inside its transaction, so a
// lock during the row writes rolls them back instead of committing an adopted vault.
// Real services and real repositories (real SQL text); the pools are in-memory recording doubles that
// only make rows visible on COMMIT.
//
// Fail on main (before this change): every "ROLLBACK fails" case (main threw the rollback error or
// mapped it to 400 and released the client healthy; the migration also skipped migration_failed) and
// "lock during the enrollment row writes" (main committed the rows). Guards that pass on main: the
// three happy paths.

import { afterEach, describe, expect, it, vi } from 'vitest';

const legacySource = vi.hoisted(() => ({ pool: undefined as unknown }));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  const Pool = function LegacySourcePool() { return legacySource.pool } as unknown;
  return { ...actual, Pool, default: { ...actual.default, Pool } };
});

import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { HumanRecoveryService } from '../../../../../../services/sulla-vault/src/localAuthority/HumanRecoveryService';
import { LegacyMigrationService } from '../../../../../../services/sulla-vault/src/localAuthority/LegacyMigrationService';
import { LocalVaultError } from '../../../../../../services/sulla-vault/src/localAuthority/LocalVaultError';
import { VaultEnrollmentService } from '../../../../../../services/sulla-vault/src/localAuthority/VaultEnrollmentService';
import { PostgresLocalAuthorityRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresLocalAuthorityRepository';
import {
  PostgresLegacyCredentialRepository, PostgresVaultMigrationRepository, PostgresVaultRecoveryRepository, PostgresVaultSyncStateRepository, PostgresVaultUserRepository,
} from '../../../../../../services/sulla-vault/src/repositories/PostgresVaultAuthorityRepositories';
import { PostgresVaultItemRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresVaultItemRepositories';

type Row = { rows: unknown[]; rowCount: number };

/**
 * A pg.Pool double with transaction semantics: INSERTs made inside BEGIN … COMMIT become visible in
 * `committed` only on COMMIT; ROLLBACK discards them. Statements can be made to fail by prefix, and
 * `onStatement` lets a spec act (lock the vault) at an exact point inside the transaction.
 */
class TransactionalPool {
  readonly statements: string[] = [];
  readonly committed: string[] = [];
  readonly releasedWith: unknown[][] = [];
  onStatement: (sql: string) => void = () => undefined;
  ended = false;
  private pending: string[] = [];

  constructor(private readonly failing: Record<string, Error> = {}) {}

  static head(sql: string): string { return sql.trim().split(/\s+/).slice(0, 3).join(' ').replace(/\(.*$/, '') }

  async query(sql: string): Promise<Row> {
    this.statements.push(`pool: ${ TransactionalPool.head(sql) }`);
    return TransactionalPool.result(sql);
  }

  async connect(): Promise<unknown> {
    return {
      query:   (sql: string) => this.clientQuery(sql),
      release: (...args: unknown[]) => { this.releasedWith.push(args) },
    };
  }

  on(): this { return this }

  async end(): Promise<void> { this.ended = true }

  asDatabase(): Database { return this as unknown as Database }

  private async clientQuery(sql: string): Promise<Row> {
    const text = sql.trim();
    this.statements.push(TransactionalPool.head(text));
    this.onStatement(text);
    const failure = Object.entries(this.failing).find(([prefix]) => text.startsWith(prefix));
    if (failure) throw failure[1];
    if (text.startsWith('BEGIN')) this.pending = [];
    if (text === 'COMMIT') this.committed.push(...this.pending.splice(0));
    if (text === 'ROLLBACK') this.pending = [];
    const insert = /^INSERT INTO (\w+)/.exec(text);
    if (insert) this.pending.push(insert[1]);
    return TransactionalPool.result(text);
  }

  private static result(sql: string): Row {
    return /RETURNING id/.test(sql) ? { rows: [{ id: 'batch-1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
}

/** The host capabilities every service under test shares, wired to one vault pool and the real runner. */
class FakeHost {
  generation = 1;
  migrationState = 'migration_required';
  readonly localStore: PostgresLocalAuthorityRepository;
  readonly db: Database;

  constructor(readonly pool: TransactionalPool) {
    this.db = pool.asDatabase();
    this.localStore = new PostgresLocalAuthorityRepository(this.db);
  }

  lockNow(): void { this.generation += 1 }

  runSecurityOperation<T>(operation: () => Promise<T>): Promise<T> { return operation() }

  runTransaction<T>(operation: (client: never) => Promise<T>): Promise<T> { return this.localStore.transaction(operation as never) }

  requireStableGeneration(generation: number): void {
    if (generation !== this.generation) throw new LocalVaultError('vault_locked', 423, 'Vault state changed during request');
  }

  requireGeneration(generation: number): void {
    if (generation !== this.generation) throw new LocalVaultError('vault_locked', 423, 'Vault locked during request');
  }
}

const bytes = (value: number) => ({ type: 'Buffer', data: [value, value] });

class BackupImportFixture {
  readonly host: FakeHost & Record<string, unknown>;
  readonly service: HumanRecoveryService;

  constructor(readonly pool: TransactionalPool) {
    const host = new FakeHost(pool) as FakeHost & Record<string, unknown>;
    const payload = {
      user:     { id: 'u-1', email: 'owner@example.test', login_hash_salt: bytes(1), login_hash_verifier: bytes(2), public_key: 'pk', encrypted_private_key: {}, encrypted_user_key: {}, kdf: {} },
      items:    [{ id: 'i-1', item_type: 'login', ciphertext: 'c', encrypted_item_key: {}, agent_policy: {}, integration_ref: null, revision: 1, created_at: 't', updated_at: 't' }],
      recovery: { recovery_salt: 's', recovery_verifier: 'v', encrypted_user_key: {} },
    };
    Object.assign(host, {
      validateHumanSession: () => ({ phase: 'pre-unlock' }),
      userRepository:       new PostgresVaultUserRepository(host.db),
      itemRepository:       new PostgresVaultItemRepository(host.db),
      recoveryRepository:   new PostgresVaultRecoveryRepository(host.db),
      localCryptoProvider:  { get: async() => ({ backups: { open: () => payload } }) },
      auditHumanAction:     (client: { query(sql: string, values: unknown[]): Promise<unknown> }, actor: string, action: string) => client.query('INSERT INTO audit_log(actor_id,action) VALUES ($1,$2)', [actor, action]),
    });
    this.host = host;
    this.service = new HumanRecoveryService(host as never);
  }

  run(): Promise<void> { return this.service.importHumanBackup('session', 'csrf', 'backup-password', { version: 1 } as never) }
}

describe('Backup import transaction', () => {
  it('a lock during the import with a failing ROLLBACK surfaces 423, commits nothing and destroys the client', async() => { // risk: real error masked as a bad password; broken connection pooled
    const rollbackError = new Error('connection terminated');
    const fx = new BackupImportFixture(new TransactionalPool({ ROLLBACK: rollbackError }));
    fx.pool.onStatement = sql => { if (sql.startsWith('INSERT INTO users')) fx.host.lockNow() };

    await expect(fx.run()).rejects.toMatchObject({ code: 'vault_locked', status: 423 });

    expect(fx.pool.statements.at(-1)).toBe('ROLLBACK');
    expect(fx.pool.committed).toEqual([]);
    expect(fx.pool.releasedWith).toEqual([[rollbackError]]);
  });

  it('commits the user, items, recovery and audit row and releases the client healthy', async() => { // risk: restored vault data lost or connection leaked
    const fx = new BackupImportFixture(new TransactionalPool());

    await expect(fx.run()).resolves.toBeUndefined();

    expect(fx.pool.committed).toEqual(['users', 'items', 'local_vault_recovery', 'audit_log']);
    expect(fx.pool.statements.filter(sql => !sql.startsWith('pool:'))[0]).toBe('BEGIN');
    expect(fx.pool.statements.at(-1)).toBe('COMMIT');
    expect(fx.pool.releasedWith.map(args => args[0])).toEqual([undefined]);
  });
});

class LegacyMigrationFixture {
  readonly host: FakeHost & Record<string, unknown>;
  readonly service: LegacyMigrationService;
  readonly legacyVmk = Buffer.alloc(32, 0x44);

  constructor(readonly pool: TransactionalPool, readonly legacy: TransactionalPool = new TransactionalPool()) {
    legacySource.pool = legacy;
    const host = new FakeHost(pool) as FakeHost & Record<string, unknown>;
    const keys = { userId: 'u-1', userKey: new Uint8Array(32).fill(7), legacyVmk: this.legacyVmk as Uint8Array | undefined };
    Object.assign(host, {
      config:                     { legacyDatabaseUrl: 'postgresql://legacy-source/sulla' },
      requireControlIdentity:     () => undefined,
      requireKeys:                () => keys,
      legacyCredentialRepository: new PostgresLegacyCredentialRepository(),
      migrationRepository:        new PostgresVaultMigrationRepository(host.db),
      itemRepository:             new PostgresVaultItemRepository(host.db),
    });
    this.host = host;
    this.service = new LegacyMigrationService(host as never);
  }

  run() { return this.service.migrateLegacy('control', 'token') }
}

afterEach(() => { legacySource.pool = undefined });

describe('Legacy credential migration transactions', () => {
  it('a lock during the import with a failing ROLLBACK surfaces 423, marks the migration failed and destroys the client', async() => { // risk: real error masked; migration state left claiming success-in-progress; broken connection pooled
    const rollbackError = new Error('connection terminated');
    const fx = new LegacyMigrationFixture(new TransactionalPool({ ROLLBACK: rollbackError }));
    fx.pool.onStatement = sql => { if (sql.startsWith('INSERT INTO local_vault_migration_batches')) fx.host.lockNow() };

    await expect(fx.run()).rejects.toMatchObject({ code: 'vault_locked', status: 423 });

    expect(fx.host.migrationState).toBe('migration_failed');
    expect(fx.pool.committed).toEqual([]);
    expect(fx.pool.releasedWith).toEqual([[rollbackError]]);
    expect(fx.pool.statements).toContain('pool: UPDATE local_vault_migration_batches SET');
    expect(fx.legacyVmk.every(byte => byte === 0x44)).toBe(true); // nothing imported: legacy key kept for a retry
  });

  it('a failed legacy-source read with a failing ROLLBACK reports migration_failed and destroys that client', async() => { // risk: broken legacy connection reused
    const rollbackError = new Error('legacy connection terminated');
    const legacy = new TransactionalPool({ SELECT: new Error('relation missing'), ROLLBACK: rollbackError });
    const fx = new LegacyMigrationFixture(new TransactionalPool(), legacy);

    await expect(fx.run()).rejects.toMatchObject({ code: 'migration_failed', status: 409 });

    expect(legacy.statements).toEqual(['BEGIN READ ONLY', "SELECT 'integration_value'::text AS", 'ROLLBACK']);
    expect(legacy.releasedWith).toEqual([[rollbackError]]);
    expect(legacy.ended).toBe(true);
    expect(fx.host.migrationState).toBe('migration_failed');
    expect(fx.pool.statements).toEqual([]);
  });

  it('commits the batch, zeroes the legacy key and releases both clients healthy', async() => { // risk: migration never completes or leaks connections
    const fx = new LegacyMigrationFixture(new TransactionalPool());

    await expect(fx.run()).resolves.toEqual({ batchId: 'batch-1', imported: 0, skipped: 0, state: 'unlocked' });

    expect(fx.legacy.statements[0]).toBe('BEGIN READ ONLY');
    expect(fx.legacy.statements.at(-1)).toBe('COMMIT');
    expect(fx.legacy.releasedWith.map(args => args[0])).toEqual([undefined]);
    expect(fx.pool.statements.filter(sql => !sql.startsWith('pool:'))).toEqual([
      'BEGIN', 'SELECT pg_advisory_xact_lock', 'INSERT INTO local_vault_migration_batches', 'UPDATE local_vault_migration_batches SET', 'COMMIT',
    ]);
    expect(fx.pool.committed).toEqual(['local_vault_migration_batches']);
    expect(fx.pool.releasedWith.map(args => args[0])).toEqual([undefined]);
    expect(fx.legacyVmk.every(byte => byte === 0)).toBe(true);
    expect(fx.host.migrationState).toBe('unlocked');
  });
});

class EnrollmentCommitFixture {
  static readonly REQUEST_ID = 'e10c0000-0000-4000-8000-000000000021';
  readonly host: FakeHost & Record<string, unknown>;
  readonly service: VaultEnrollmentService;
  readonly staged = {
    expiresAt: Date.now() + 60_000, head: {}, cloudUserId: 'cloud-user',
    userKey: new Uint8Array(32).fill(1), privateKey: new Uint8Array(32).fill(2), masterKey: new Uint8Array(32).fill(3),
    bundle: {
      vaultUserId: 'e10a0000-0000-4000-8000-000000000021', vaultId: 'e10b0000-0000-4000-8000-000000000022', epoch: 1, bundleGeneration: 1,
      publicKey: 'pk', encryptedPrivateKey: { ct: 'p' }, encryptedUserKey: { ct: 'u' }, kdf: { salt: 's', memoryBytes: 65536, ops: 2 },
    },
  };

  constructor(readonly pool: TransactionalPool) {
    const host = new FakeHost(pool) as FakeHost & Record<string, unknown>;
    Object.assign(host, {
      keys:                     null,
      pendingVaultEnrollments:  new Map([[EnrollmentCommitFixture.REQUEST_ID, this.staged]]),
      requireApprovalIdentity:  () => undefined,
      isSetupRequired:          async() => true,
      userRepository:           new PostgresVaultUserRepository(host.db),
      syncStateRepository:      new PostgresVaultSyncStateRepository(host.db),
      stageCacheUpdate:         () => { host.cacheStaged = true },
    });
    this.host = host;
    this.service = new VaultEnrollmentService(host as never);
  }

  commit() { return this.service.commitVaultEnrollment('approval', 'token', EnrollmentCommitFixture.REQUEST_ID) }
}

describe('Enrollment commit transaction', () => {
  it('a lock during the row writes rolls them back and fails with 423', async() => { // risk: adopted vault rows committed after the user locked
    const fx = new EnrollmentCommitFixture(new TransactionalPool());
    fx.pool.onStatement = sql => { if (sql.startsWith('INSERT INTO users')) fx.host.lockNow() };

    await expect(fx.commit()).rejects.toMatchObject({ code: 'vault_locked', status: 423 });

    expect(fx.pool.statements.at(-1)).toBe('ROLLBACK');
    expect(fx.pool.statements).not.toContain('COMMIT');
    expect(fx.pool.committed).toEqual([]);
    expect(fx.host.keys).toBeNull();
    expect(fx.staged.masterKey.every(byte => byte === 0)).toBe(true);
  });

  it('commits both rows and loads the keys when no lock happens', async() => { // risk: the in-transaction check refuses every enrollment
    const fx = new EnrollmentCommitFixture(new TransactionalPool());

    await expect(fx.commit()).resolves.toEqual({ adopted: true });

    expect(fx.pool.committed).toEqual(['users', 'cloud_vault_sync_state']);
    expect(fx.host.migrationState).toBe('unlocked');
    expect((fx.host.keys as { userKey: Uint8Array }).userKey.every(byte => byte === 1)).toBe(true);
  });
});
