// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { VaultPrincipalRepository } from '../../../../../../services/sulla-files/src/repositories/VaultPrincipalRepository';
import { VaultPrincipalAdopter } from '../../../../../../services/sulla-files/src/vaultPrincipal';

class VaultPrincipalDatabaseFixture {
  readonly calls: Array<{ query: string; values?: unknown[] }> = [];
  readonly client = {
    query: async <T>(query: string, values?: unknown[]) => {
      this.calls.push({ query, values });
      if (query.startsWith('SELECT id::text')) return { rows: this.collections, rowCount: this.collections.length } as T;
      if (query.startsWith('SELECT 1 FROM files_collection_key_bundles')) {
        return { rows: this.conflictingBundle ? [{ '?column?': 1 }] : [], rowCount: this.conflictingBundle ? 1 : 0 } as T;
      }
      return { rows: [], rowCount: 0 } as T;
    },
    release: () => { this.released = true; },
  };
  collections: Array<{ id: string; owner_user_id: string }> = [];
  conflictingBundle = false;
  released = false;
  connect = async() => this.client;
}

describe('Files vault principal adoption characterization', () => {
  it('transfers only sentinel-owned collections and commits before updating the configured principal', async() => {
    // risk: tenant isolation — adoption must never transfer a collection owned by another principal.
    const database = new VaultPrincipalDatabaseFixture();
    database.collections = [
      { id: '00000000-0000-0000-0000-000000000001', owner_user_id: 'desktop-user' },
      { id: '00000000-0000-0000-0000-000000000002', owner_user_id: 'principal-existing' },
    ];
    const config = { userId: 'desktop-user' };

    await new VaultPrincipalAdopter(new VaultPrincipalRepository(database as never)).adopt(config as never, 'principal-new');

    expect(config.userId).toBe('principal-new');
    expect(database.calls.map(call => call.query.split(' ')[0])).toEqual(['BEGIN', 'SELECT', 'SELECT', 'UPDATE', 'UPDATE', 'COMMIT']);
    expect(database.calls[3].values).toEqual([['00000000-0000-0000-0000-000000000001'], 'principal-new', 'desktop-user']);
    expect(database.calls[4].values).toEqual([['00000000-0000-0000-0000-000000000001'], 'principal-new']);
    expect(database.released).toBe(true);
  });

  it('rolls back a conflicting collection key bundle and leaves the principal unchanged', async() => {
    // risk: key custody — a collection with a different principal bundle requires secure migration.
    const database = new VaultPrincipalDatabaseFixture();
    database.collections = [{ id: '00000000-0000-0000-0000-000000000001', owner_user_id: 'desktop-user' }];
    database.conflictingBundle = true;
    const config = { userId: 'desktop-user' };

    await expect(new VaultPrincipalAdopter(new VaultPrincipalRepository(database as never)).adopt(config as never, 'principal-new'))
      .rejects.toThrow('secure migration is required');

    expect(config.userId).toBe('desktop-user');
    expect(database.calls.at(-1)?.query).toBe('ROLLBACK');
    expect(database.released).toBe(true);
    expect(database.calls.some(call => call.query.startsWith('UPDATE'))).toBe(false);
  });
});
