// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ProfileGeneration } from '@sulla/vault-profiles';
import { VaultProfileSession } from '../src/profiles/VaultProfileSession.js';
import { VaultProfileSessionFactory } from '../src/profiles/VaultProfileSessionFactory.js';
import { VaultRepositories } from '../src/repositories/VaultRepositories.js';

describe('VaultRepositories profile session composition', () => {
  it('routes each profile write through its own injected pool', async () => {
    const poolA = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), connect: vi.fn() };
    const poolB = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), connect: vi.fn() };
    const reposA = new VaultRepositories(new VaultProfileSessionFactory(poolA as never, true).forProfile('a', 1, poolA as never));
    const reposB = new VaultRepositories(new VaultProfileSessionFactory(poolB as never, true).forProfile('b', 1, poolB as never));

    await reposA.items.insertImportedItem(['item-a', 'owner-a', 'note', 'cipher', 'key', {}]);
    await reposB.items.insertImportedItem(['item-b', 'owner-b', 'note', 'cipher', 'key', {}]);

    expect(poolA.query).toHaveBeenCalledOnce();
    expect(poolB.query).toHaveBeenCalledOnce();
    expect(poolA.query.mock.calls[0][1]?.[0]).toBe('item-a');
    expect(poolB.query.mock.calls[0][1]?.[0]).toBe('item-b');
  });

  it('refuses a stale generation before protected repository SQL reaches the pool', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const pool = { query, connect: vi.fn() };
    let current = 3;
    const session = new VaultProfileSession({ profileId: 'profile-a', generation: new ProfileGeneration(3) }, pool as never, undefined, () => ({ profileId: 'profile-a', generation: new ProfileGeneration(current) }));
    const repositories = new VaultRepositories(session);
    current = 4;

    await expect(repositories.items.insertImportedItem(['item-a', 'owner-a', 'note', 'cipher', 'key', {}])).rejects.toThrow(/stale/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('preserves the legacy SQL and legacy pool when profile provisioning is off', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const legacyPool = { query, connect: vi.fn() };
    const profilePool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
    const session = new VaultProfileSessionFactory(legacyPool as never, false).forProfile('profile-b', 2, profilePool as never);
    const repositories = new VaultRepositories(session);
    const sql = 'INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy) VALUES ($1,$2,$3,$4,$5,$6)';
    const values = ['item', 'owner', 'note', 'cipher', 'key', {}];

    await repositories.items.insertImportedItem(values);

    expect(query).toHaveBeenCalledWith(sql, values);
    expect(profilePool.query).not.toHaveBeenCalled();
  });
});
