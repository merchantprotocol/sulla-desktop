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
    await expect(session.database.query('UPDATE tokens SET value=$1', ['secret'])).rejects.toThrow(/stale/i);
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
    await expect(a.database.query('SELECT key')).rejects.toThrow(/stale/i);
    await b.database.query('SELECT key');
    expect(queryA).not.toHaveBeenCalled();
    expect(queryB).toHaveBeenCalledOnce();
  });

  it('does not throw synchronously for stale callback queries and calls the callback asynchronously', async () => {
    let callbackError: unknown;
    const query = vi.fn();
    const session = new VaultProfileSession({ profileId: 'a', generation: new ProfileGeneration(1) }, { query } as never);
    session.invalidate();
    let returned: unknown;
    expect(() => { returned = session.database.query('SELECT key', (error: unknown) => { callbackError = error; }); }).not.toThrow();
    expect(callbackError).toBeUndefined();
    expect(returned).toBeUndefined();
    await new Promise(resolve => queueMicrotask(resolve));
    expect(callbackError).toBeInstanceOf(Error);
    expect(query).not.toHaveBeenCalled();
  });

  it('fences clients from both promise-style and callback-style connect', async () => {
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const client = { query: clientQuery, release: vi.fn() };
    const connect = vi.fn((callback?: (error: unknown, client: unknown, done: () => void) => void) => {
      if (!callback) return Promise.resolve(client);
      callback(undefined, client, () => undefined);
      return undefined;
    });
    const session = new VaultProfileSession({ profileId: 'a', generation: new ProfileGeneration(1) }, { connect } as never);
    const promised = await session.database.connect();
    let viaCallback: { query(sql: string): Promise<unknown> } | undefined;
    const pool = session.database as unknown as { connect(callback: (error: unknown, client: typeof viaCallback) => void): void };
    expect(pool.connect((_error, connected) => { viaCallback = connected; })).toBeUndefined();
    await promised.query('SELECT 1');
    await viaCallback!.query('SELECT 1');
    expect(clientQuery).toHaveBeenCalledTimes(2);
    session.invalidate();
    await expect(promised.query('SELECT key')).rejects.toThrow(/stale/i);
    await expect(viaCallback!.query('SELECT key')).rejects.toThrow(/stale/i);
    expect(clientQuery).toHaveBeenCalledTimes(2);
  });

  it('rejects promise-style stale queries with a stale error', async () => {
    const query = vi.fn();
    const session = new VaultProfileSession({ profileId: 'a', generation: new ProfileGeneration(1) }, { query } as never);
    session.invalidate();
    await expect(session.database.query('SELECT key')).rejects.toThrow(/stale/i);
    expect(query).not.toHaveBeenCalled();
  });
});
