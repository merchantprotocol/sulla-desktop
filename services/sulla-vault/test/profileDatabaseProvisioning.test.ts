// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ProfileBoundary, ProfileCatalogEntry } from '@sulla/vault-profiles';
import { ProfileDatabaseResolver } from '../src/profiles/ProfileDatabaseResolver.js';
import { ProfileDatabaseProvisioner } from '../src/profiles/ProfileDatabaseProvisioner.js';
import { PostgresProfileDatabaseRepository } from '../src/repositories/PostgresProfileDatabaseRepository.js';

const entry = (cloudUserId: string) => new ProfileCatalogEntry({ cloudUserId, displayLabel: cloudUserId });

describe('dark-launch profile database boundary', () => {
  it('maps two Cloud identities to different databases and never resolves B to A', () => {
    const a = entry('cloud-user-a');
    const b = entry('cloud-user-b');
    const resolver = new ProfileDatabaseResolver();
    expect(resolver.resolve([a, b], a.profileId.value)).toBe(a.dbIdentifier);
    expect(resolver.resolve([a, b], b.profileId.value)).toBe(b.dbIdentifier);
    expect(a.dbIdentifier).not.toBe(b.dbIdentifier);
    expect(() => resolver.resolve([a, b], 'profile_unknown')).toThrow('Unknown profile id');
  });

  it('fails closed on a catalog database-identifier collision', () => {
    const a = entry('cloud-user-a');
    const b = entry('cloud-user-b');
    const forged = { ...b, dbIdentifier: a.dbIdentifier };
    expect(() => new ProfileDatabaseResolver().resolve([a, forged] as ProfileCatalogEntry[], b.profileId.value))
      .toThrow(/collision|does not match/i);
    expect(() => new ProfileBoundary().assertCollisionSafe([a, forged])).toThrow();
  });

  it('keeps injection-shaped Cloud IDs out of SQL text and binds them only as values', async() => {
    const injection = "x'; DROP DATABASE sulla_vault; --";
    const target = entry(injection);
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db = { query: async(sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return sql.startsWith('SELECT') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
    } } as any;
    const repository = new PostgresProfileDatabaseRepository(db);
    await new ProfileDatabaseProvisioner(repository).provision(target, []);
    expect(calls.map(call => call.sql).join('\n')).not.toContain(injection);
    expect(calls[0].params).toEqual([target.dbIdentifier]);
    expect(calls[1].sql).toBe(`CREATE DATABASE "${target.dbIdentifier}"`);
  });

  it('uses an additive-only catalog migration', async() => {
    const sql = await readFile(new URL('../migrations/020_vault_profile_catalog.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS vault_profile_catalog/);
    expect(sql).not.toMatch(/\b(?:ALTER|DROP)\s+TABLE\b/i);
    expect(sql).toMatch(/db_identifier text NOT NULL UNIQUE/);
    expect(sql).not.toMatch(/token|password|secret|private_key|ciphertext/i);
  });
});
