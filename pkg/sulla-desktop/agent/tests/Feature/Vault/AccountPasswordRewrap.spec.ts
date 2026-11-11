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

  static async create(): Promise<AccountPasswordRewrapFixture> {
    const master = await deriveMasterKey('current local password');
    const verifier = makeLoginVerifier(await deriveLoginHash(master.key));
    const repositories = new FakeVaultRepositories({
      login_hash_salt: verifier.salt, login_hash_verifier: verifier.verifier,
      kdf: { password: { salt: master.salt, parameters: master.parameters } },
    });
    const transactionClient = { query: async() => ({ rows: [], rowCount: 0 }), release: () => undefined };
    const database = { query: async() => ({ rows: [], rowCount: 0 }), connect: async() => transactionClient };
    const authority = Object.create(LocalVaultAuthority.prototype) as LocalVaultAuthority;
    const state = authority as unknown as Record<string, unknown>;
    Object.assign(state, {
      db: database, config: thisConfig(), userRepository: repositories, rewrapHistory: repositories,
      auditLogRepository: repositories, securityOperationTail: Promise.resolve(), generation: 0,
      keys: { userId: 'user-1', userKey: Uint8Array.from({ length: 32 }, () => 9) },
      humanSessions: new Map([['session', { csrf: 'csrf', expiresAt: Date.now() + 60_000, phase: 'unlocked' }]]),
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
  it('keeps local encrypted_user_key unchanged even when Cloud KDF differs; human password changes still write it', async() => {
    // risk: account sign-in must not rewrite the user's local encrypted_user_key; an intentional human password change must.
    const fixture = await AccountPasswordRewrapFixture.create();
    await fixture.rewrap('B'.repeat(22));
    expect(fixture.repositories.kdfWrites).toHaveLength(1);
    expect(fixture.repositories.passwordWrites).toHaveLength(0);

    await fixture.authority.changeHumanPassword('session', 'csrf', 'current local password', 'next local password');
    expect(fixture.repositories.passwordWrites).toHaveLength(1);
  });
});
