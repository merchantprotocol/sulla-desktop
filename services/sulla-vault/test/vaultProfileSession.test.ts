// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ProfileGeneration } from '@sulla/vault-profiles';
import { VaultProfileSession } from '../src/profiles/VaultProfileSession.js';
import { VaultProfileSessionFactory } from '../src/profiles/VaultProfileSessionFactory.js';

describe('vault profile session query fence', () => {
  it('uses its injected pool and rejects stale-generation reads and writes', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool = { query, connect: vi.fn() } as never;
    let activeGeneration = 7;
    const session = new VaultProfileSession({ profileId: 'profile-a', generation: new ProfileGeneration(7) }, pool, undefined, () => ({ profileId: 'profile-a', generation: new ProfileGeneration(activeGeneration) }));
    await session.database.query('SELECT token');
    expect(query).toHaveBeenCalledOnce();
    activeGeneration = 8;
    expect(() => session.database.query('UPDATE tokens SET value=$1', ['secret'])).toThrow(/stale/i);
    expect(query).toHaveBeenCalledOnce();
  });

  it('keeps the legacy pool when profile routing is disabled', async () => {
    const legacy = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const other = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const session = new VaultProfileSessionFactory(legacy as never, false).forProfile('profile-b', 2, other as never);
    await session.database.query('SELECT 1');
    expect(legacy.query).toHaveBeenCalledOnce();
    expect(other.query).not.toHaveBeenCalled();
  });

  it('invalidates only the captured profile session', async () => {
    const queryA = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const queryB = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const a = new VaultProfileSession({ profileId: 'a', generation: new ProfileGeneration(1) }, { query: queryA } as never);
    const b = new VaultProfileSession({ profileId: 'b', generation: new ProfileGeneration(1) }, { query: queryB } as never);
    a.invalidate();
    expect(() => a.database.query('SELECT key')).toThrow(/stale/i);
    await b.database.query('SELECT key');
    expect(queryA).not.toHaveBeenCalled();
    expect(queryB).toHaveBeenCalledOnce();
  });
});
