// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ProfileGeneration } from '@sulla/vault-profiles';
import { LocalVaultAuthority } from '../src/localAuthority.js';
import { VaultProfileSession } from '../src/profiles/VaultProfileSession.js';
import { VaultRepositories } from '../src/repositories/VaultRepositories.js';
import { BrokerExecutionService } from '../src/localAuthority/BrokerExecutionService.js';
import { AuthSession, TokenPair } from '@sulla/domain';
import { VaultItemTokenStore } from '../src/sullaCloudSession/VaultItemTokenStore.js';

const config = {
  bootstrapServiceToken: 'bootstrap-token-000000000000000000000000',
  controlServiceToken: 'control-token-00000000000000000000000000',
  approvalServiceToken: 'approval-token-000000000000000000000000',
  brokerServiceToken: 'broker-token-000000000000000000000000000',
  filesServiceToken: 'files-token-0000000000000000000000000000',
};

function authority(profileId: string): LocalVaultAuthority {
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const session = new VaultProfileSession({ profileId, generation: new ProfileGeneration(1) }, pool as never);
  return new LocalVaultAuthority(pool as never, config as never, undefined, new VaultRepositories(session));
}

describe('LocalVaultAuthority profile invalidation', () => {
  it('zeroizes only the invalidated profile key buffers', () => {
    // risk: secret custody — profile A must be erased without touching profile B's decrypted key buffers.
    const a = authority('profile-a');
    const b = authority('profile-b');
    const aUserKey = Buffer.from([4, 5, 6]);
    const aPrivateKey = new Uint8Array([7, 8]);
    const bUserKey = Buffer.from([9, 10, 11]);
    const bPrivateKey = new Uint8Array([12, 13]);
    (a as unknown as { keys: unknown }).keys = { userId: 'a', publicKey: 'a', userKey: aUserKey, privateKey: aPrivateKey };
    (b as unknown as { keys: unknown }).keys = { userId: 'b', publicKey: 'b', userKey: bUserKey, privateKey: bPrivateKey };

    a.invalidate('profile-a');
    expect([...aUserKey]).toEqual([0, 0, 0]);
    expect([...aPrivateKey]).toEqual([0, 0]);
    expect([...bUserKey]).toEqual([9, 10, 11]);
    expect([...bPrivateKey]).toEqual([12, 13]);
  });

  it('invalidates and renews the query session as part of lock', async () => {
    // risk: profile isolation — a locked session must reject outstanding queries but remain re-unlockable.
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const session = new VaultProfileSession({ profileId: 'profile-a', generation: new ProfileGeneration(1) }, pool as never);
    const authority = new LocalVaultAuthority(pool as never, config as never, undefined, new VaultRepositories(session));
    await authority.lock();
    await expect(session.database.query('SELECT 1')).rejects.toThrow(/stale/i);
    await authority.database.query('SELECT 1');
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it('drops delayed OAuth refresh writes when the captured profile generation is stale', async () => {
    // risk: token custody — an old refresh must not overwrite credentials after lock/profile change.
    let release!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; });
    const profileContext = { profileId: 'profile-a', generation: new ProfileGeneration(1) };
    let activeGeneration = 1;
    const host = {
      profileContext,
      generation: activeGeneration,
      oauthRefreshQueues: new Map([['profile-a/integration/account', queued]]),
      assertProfileCurrent: vi.fn(),
      requireGeneration: vi.fn((generation: number) => {
        if (generation !== activeGeneration) throw new Error('stale authority generation');
      }),
    };
    const operation = vi.fn(async () => 'persisted');
    const logger = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new BrokerExecutionService(host as never);
    const delayed = service.withCredentialQueue({ integrationId: 'integration', accountId: 'account' }, operation);
    activeGeneration = 2;
    host.generation = 2;
    release();
    await expect(delayed).rejects.toThrow(/stale/i);
    expect(operation).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledOnce();
    logger.mockRestore();
  });

  it('does not reach the token repository when a refresh snapshot is stale', async () => {
    // risk: credential integrity — a delayed Cloud refresh cannot persist after its authority generation changes.
    let generation = 4;
    const record = {
      itemId: 'synthetic-item', revision: 2, userId: 'synthetic-user', activeContractorId: 'synthetic-user',
      accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
    };
    const gateway = { load: vi.fn(async () => record), replaceTokens: vi.fn(async () => 3), purge: vi.fn(async () => true) };
    const profile = { profileId: 'profile-a', generation: new ProfileGeneration(1) };
    const vault = {
      profileContext: () => profile,
      generation: () => generation,
      assertProfileCurrent: vi.fn(),
      requireGeneration: (captured: number) => { if (captured !== generation) throw new Error('stale refresh'); },
    };
    const logger = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new VaultItemTokenStore(gateway as never, vault as never);
    const expected = await store.read();
    expect(expected).not.toBeNull();
    generation = 5;
    const next = new AuthSession('synthetic-user', 'synthetic-user', new TokenPair('next-access', 'next-refresh'), 2);
    await expect(store.compareAndSet(expected!, next)).resolves.toBe(false);
    expect(gateway.replaceTokens).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledOnce();
    logger.mockRestore();
  });
});
