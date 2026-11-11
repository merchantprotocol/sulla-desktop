// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { deriveLoginHash, deriveMasterKey } from '@sulla/vault-crypto';
import { makeLoginVerifier } from '../../../../../../services/sulla-vault/src/auth';
import { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';

class FakeVaultRepositories {
  readonly kdfWrites: unknown[] = [];
  readonly passwordWrites: unknown[][] = [];
  readonly activateWrites: unknown[][] = [];
  account: { login_hash_salt: Buffer; login_hash_verifier: Buffer; kdf: { cloudUserId?: string; password?: { salt: string; parameters: { memoryBytes: number; operations: number } } } };

  constructor(account: FakeVaultRepositories['account']) { this.account = account; }
  async findCredentials() { return { rows: [this.account], rowCount: 1 }; }
  async updateKdf(...args: unknown[]) { this.kdfWrites.push(args); }
  async updatePassword(...args: unknown[]) { this.passwordWrites.push(args); }
  async preserveCurrentPasswordWrap() { return; }
  async recordHumanAction() { return; }
}

class AccountPasswordRewrapFixture {
  readonly repositories: FakeVaultRepositories;
  readonly authority: LocalVaultAuthority;

  private constructor(repositories: FakeVaultRepositories, authority: LocalVaultAuthority) {
    this.repositories = repositories;
    this.authority = authority;
  }

  static async create(options: { keys?: boolean; setupRequired?: boolean; cloudUserId?: string } = {}): Promise<AccountPasswordRewrapFixture> {
    const master = await deriveMasterKey('current local password');
    const verifier = makeLoginVerifier(await deriveLoginHash(master.key));
    const repositories = new FakeVaultRepositories({
      login_hash_salt: verifier.salt, login_hash_verifier: verifier.verifier,
      kdf: { ...(options.cloudUserId ? { cloudUserId: options.cloudUserId } : {}), password: { salt: master.salt, parameters: master.parameters } },
    });
    const transactionClient = { query: async() => ({ rows: [], rowCount: 0 }), release: () => undefined };
    const database = { query: async() => ({ rows: [], rowCount: 0 }), connect: async() => transactionClient };
    const authority = Object.create(LocalVaultAuthority.prototype) as LocalVaultAuthority;
    const state = authority as unknown as Record<string, unknown>;
    Object.assign(state, {
      db: database, config: thisConfig(), userRepository: repositories, rewrapHistory: repositories,
      auditLogRepository: repositories, securityOperationTail: Promise.resolve(), generation: 0, cacheChallenges: new Map(),
      keys: options.keys === false ? undefined : { userId: 'user-1', userKey: Uint8Array.from({ length: 32 }, () => 9) },
      humanSessions: new Map([['session', { csrf: 'csrf', expiresAt: Date.now() + 60_000, phase: 'unlocked' }]]),
    });
    state.isSetupRequired = async() => options.setupRequired ?? false;
    state.activateMasterKey = async(...args: unknown[]) => {
      repositories.activateWrites.push(args);
      if (options.setupRequired) state.keys = { userId: 'new-user', userKey: Uint8Array.from({ length: 32 }, () => 8) };
    };
    state.userRepository = Object.assign(repositories, {
      findActiveOwner: async() => ({ rows: [{ id: 'user-1', kdf: { cloudUserId: options.cloudUserId } }], rowCount: 1 }),
    });
    master.key.fill(0);
    return new AccountPasswordRewrapFixture(repositories, authority);
  }

  async rewrap(salt: string): Promise<unknown> {
    return this.authority.rewrapForAccountPassword('approval', 'a'.repeat(40), {
      cloudUserId: 'cloud-user', masterKey: 'A'.repeat(43),
      kdf: { alg: 'argon2id13', salt, memoryBytes: 67_108_864, ops: 3 },
    });
  }
}

function thisConfig() {
  return {
    mode: 'desktop' as const, port: 0, databaseUrl: 'postgresql://synthetic/unused', jwtSecret: 'j'.repeat(64),
    extensionOrigins: [], bootstrapServiceId: 'bootstrap', bootstrapServiceToken: 'b'.repeat(40),
    controlServiceId: 'control', controlServiceToken: 'c'.repeat(40), approvalServiceId: 'approval', approvalServiceToken: 'a'.repeat(40),
    brokerServiceId: 'broker', brokerServiceToken: 'r'.repeat(40), filesServiceId: 'files', filesServiceToken: 'f'.repeat(40),
  };
}

describe('Cloud account password rewrap', () => {
  it('creates a vault on fresh install via activateMasterKey', async() => {
    // risk: fresh Cloud users must get a local vault without rewriting an existing key.
    const fixture = await AccountPasswordRewrapFixture.create({ keys: false, setupRequired: true });
    await fixture.rewrap('B'.repeat(22));
    expect(fixture.repositories.activateWrites).toHaveLength(1);
    expect(fixture.repositories.passwordWrites).toHaveLength(0);
  });

  it('does not activate or write a key for an existing locked vault', async() => {
    // risk: locked existing vault key material must remain unchanged.
    const fixture = await AccountPasswordRewrapFixture.create({ keys: false, setupRequired: false, cloudUserId: 'cloud-user' });
    await fixture.rewrap('B'.repeat(22));
    expect(fixture.repositories.activateWrites).toHaveLength(0);
    expect(fixture.repositories.passwordWrites).toHaveLength(0);
    expect(fixture.repositories.kdfWrites).toHaveLength(0);
  });

  it('updates only metadata for an unlocked vault; human password changes still write the key', async() => {
    // risk: sign-in metadata must not replace the local encrypted_user_key; explicit human password changes still do.
    const fixture = await AccountPasswordRewrapFixture.create();
    await fixture.rewrap('B'.repeat(22));
    expect(fixture.repositories.kdfWrites).toHaveLength(1);
    expect(fixture.repositories.passwordWrites).toHaveLength(0);

    await fixture.authority.changeHumanPassword('session', 'csrf', 'current local password', 'next local password');
    expect(fixture.repositories.passwordWrites).toHaveLength(1);
  });

  it('rejects a different Cloud owner when the existing vault is locked', async() => {
    // risk: a different Cloud account must not claim an existing local vault.
    const fixture = await AccountPasswordRewrapFixture.create({ keys: false, setupRequired: false, cloudUserId: 'other-cloud-user' });
    await expect(fixture.rewrap('B'.repeat(22))).rejects.toMatchObject({ status: 409 });
    expect(fixture.repositories.activateWrites).toHaveLength(0);
  });
});
