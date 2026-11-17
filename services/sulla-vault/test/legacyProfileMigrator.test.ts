// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProfileCatalogEntry } from '@sulla/vault-profiles';
import { LegacyProfileMigrator, type LegacyMigrationPorts } from '../src/profiles/LegacyProfileMigrator.js';

const fixture = {
  users: [{ id: 'u1', kdf: { cloudUserId: 'cloud-a', wrappedKey: Buffer.from([0, 255, 17]) } }],
  items: [{ id: 'i1', owner_user_id: 'u1', ciphertext: Buffer.from([255, 0, 128]) }],
  local_vault_recovery: [{ owner_user_id: 'u1', recovery_ciphertext: Buffer.from([8, 0, 9]) }],
  files_key_bundle_envelopes: [{ owner_user_id: 'u1', envelope: Buffer.from([1, 2, 0, 255]) }],
  local_integration_state: [{ owner_user_id: 'u1', active_account_id: 'cloud-a' }],
  browser_sync_records: [{ vault_id: 'v1', ciphertext: Buffer.from([3, 0, 4]) }],
  audit_log: [{ id: 'a1', event_data: { ciphertext: 'opaque' } }],
};
const digest = (rows: readonly Record<string, unknown>[]) => createHash('sha256').update(JSON.stringify(rows, (_k, v) => Buffer.isBuffer(v) ? v.toString('hex') : v)).digest('hex');
const cloneRows = (rows: readonly Record<string, unknown>[]) => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? Buffer.from(value) : value])));

function setup(options: { failCopy?: string; owner?: { kdfCloudUserId?: string; activeAccountIds?: string[] } } = {}) {
  const dest = new Map<string, readonly Record<string, unknown>[]>();
  let active = 'legacy_vault';
  let backupDone = false;
  let dropped = false;
  const states: string[] = [];
  const ports: LegacyMigrationPorts = {
    backup: { createSnapshot: async () => { backupDone = true; } },
    source: {
      identifyOwner: async () => options.owner ?? { kdfCloudUserId: 'cloud-a' },
      withExclusiveReadLock: async operation => operation(),
      tables: async () => Object.keys(fixture),
      rows: async table => fixture[table as keyof typeof fixture],
    },
    destination: {
      assertFresh: async () => {},
      prepareSchema: async () => {},
      drop: async () => { dest.clear(); dropped = true; },
      withTransaction: async (_db, operation) => {
        const staged = new Map<string, readonly Record<string, unknown>[]>();
        await operation({ prepare: async tables => tables, copy: async (table, rows) => {
          if (!backupDone) throw new Error('backup missing');
          if (table === options.failCopy) throw new Error('interrupted');
          staged.set(table, cloneRows(rows));
        } });
        staged.forEach((rows, table) => dest.set(table, rows));
      },
      rows: async (_db, table) => dest.get(table) ?? [],
    },
    catalog: {
      entries: async () => [],
      setState: async (_entry, state) => { states.push(state); },
      completeAndActivate: async entry => { states.push('complete'); active = entry.dbIdentifier; },
    },
    mapping: { get: async () => active, set: async db => { active = db; } },
    hash: { digest },
  };
  const provisioner = { provision: async (_entry: ProfileCatalogEntry) => {} } as never;
  return { migrator: new LegacyProfileMigrator(true, provisioner, ports), ports, dest, states, active: () => active, dropped: () => dropped };
}

describe('opt-in lossless legacy profile migration', () => {
  it('copies realistic encrypted rows byte-for-byte and activates only after verification', async () => {
    const test = setup();
    const entry = await test.migrator.migrate(true);
    expect(test.active()).toBe(entry.dbIdentifier);
    expect(test.dest.size).toBe(Object.keys(fixture).length);
    expect(digest(test.dest.get('items')!)).toBe(digest(fixture.items));
  });

  it('rolls back failed copy, preserves legacy mapping, and permits idempotent retry', async () => {
    const test = setup({ failCopy: 'items' });
    await expect(test.migrator.migrate(true)).rejects.toThrow('interrupted');
    expect(test.active()).toBe('legacy_vault');
    expect(test.dropped()).toBe(true);
    expect(test.dest.size).toBe(0);
    const retry = setup();
    await expect(retry.migrator.migrate(true)).resolves.toBeInstanceOf(ProfileCatalogEntry);
  });

  it('refuses absent or ambiguous owner before backup, provision or catalog writes', async () => {
    for (const owner of [{}, { activeAccountIds: ['a', 'b'] }]) {
      const test = setup({ owner });
      await expect(test.migrator.migrate(true)).rejects.toThrow(/missing or ambiguous/);
      expect(test.states).toEqual([]);
      expect(test.dropped()).toBe(false);
    }
  });

  it('marks failed and preserves the original migration error when destination cleanup also fails', async () => {
    const test = setup({ failCopy: 'items' });
    const original = new Error('interrupted');
    const dropFailure = new Error('drop failed');
    test.ports.destination.drop = async () => { throw dropFailure; };
    test.ports.destination.withTransaction = async (_db, operation) => operation({ prepare: async tables => tables, copy: async () => { throw original; } });
    await expect(test.migrator.migrate(true)).rejects.toBe(original);
    expect(original.cause).toBe(dropFailure);
    expect(test.states).toContain('failed');
  });

  it('requires unlocked state and the explicit feature flag', async () => {
    const disabled = new LegacyProfileMigrator(false, {} as never, setup().ports);
    await expect(disabled.migrate(true)).rejects.toThrow(/disabled/);
    await expect(setup().migrator.migrate(false)).rejects.toThrow(/unlocked/);
  });

  it('rollback only changes the pointer and never writes to legacy', async () => {
    const test = setup();
    await test.migrator.rollback('legacy_vault');
    expect(test.active()).toBe('legacy_vault');
    expect(test.dest.size).toBe(0);
  });
});
