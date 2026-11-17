// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { ProfileCatalogEntry, ProfileBoundary } from '@sulla/vault-profiles';
import type { ProfileDatabaseProvisioner } from './ProfileDatabaseProvisioner.js';

/** All profile migration I/O is behind ports so orchestration cannot decrypt or issue SQL. */
export interface LegacyMigrationPorts {
  backup: { createSnapshot(): Promise<void> };
  source: {
    identifyOwner(): Promise<{ kdfCloudUserId?: string | null; activeAccountIds?: readonly (string | null)[] }>;
    withExclusiveReadLock<T>(operation: () => Promise<T>): Promise<T>;
    tables(): Promise<readonly string[]>;
    rows(table: string): Promise<readonly Record<string, unknown>[]>;
  };
  destination: {
    assertFresh(dbIdentifier: string): Promise<void>;
    prepareSchema(dbIdentifier: string): Promise<void>;
    drop(dbIdentifier: string): Promise<void>;
    withTransaction<T>(dbIdentifier: string, operation: (writer: { copy(table: string, rows: readonly Record<string, unknown>[]): Promise<void> }) => Promise<T>): Promise<T>;
    rows(dbIdentifier: string, table: string): Promise<readonly Record<string, unknown>[]>;
  };
  catalog: {
    entries(): Promise<ProfileCatalogEntry[]>;
    setState(entry: ProfileCatalogEntry, state: 'pending' | 'failed'): Promise<void>;
    completeAndActivate(entry: ProfileCatalogEntry): Promise<void>;
  };
  mapping: { get(): Promise<string>; set(dbIdentifier: string): Promise<void> };
  hash: { digest(rows: readonly Record<string, unknown>[]): string };
}

/** Explicit, opt-in, lossless one-profile copy. No production caller is wired to this class. */
export class LegacyProfileMigrator {
  constructor(
    private readonly enabled: boolean,
    private readonly provisioner: ProfileDatabaseProvisioner,
    private readonly ports: LegacyMigrationPorts,
    private readonly boundary: ProfileBoundary = new ProfileBoundary(),
  ) {}

  async migrate(unlocked: boolean, displayLabel = ''): Promise<ProfileCatalogEntry> {
    if (!this.enabled) throw new Error('Vault profile provisioning is disabled');
    if (!unlocked) throw new Error('Legacy vault must be unlocked and identified');
    const owner = await this.ports.source.identifyOwner();
    const primary = owner.kdfCloudUserId?.trim();
    const fallbacks = [...new Set((owner.activeAccountIds ?? []).map(id => id?.trim()).filter((id): id is string => Boolean(id)))];
    const cloudUserId = primary || (fallbacks.length === 1 ? fallbacks[0] : undefined);
    if (!cloudUserId || (primary && fallbacks.some(id => id !== primary)) || (!primary && fallbacks.length !== 1)) {
      throw new Error('Legacy vault owner is missing or ambiguous');
    }
    const entry = new ProfileCatalogEntry({ cloudUserId, displayLabel, migrationState: 'pending' });
    const catalog = await this.ports.catalog.entries();
    this.boundary.assertCollisionSafe([...catalog, entry.toJSON()]);
    await this.ports.backup.createSnapshot(); // explicit backup gate precedes *all* writes
    await this.ports.catalog.setState(entry, 'pending');
    try {
      await this.ports.destination.assertFresh(entry.dbIdentifier);
      await this.provisioner.provision(entry, catalog);
      await this.ports.destination.prepareSchema(entry.dbIdentifier);
      await this.ports.source.withExclusiveReadLock(async () => {
        const tables = await this.ports.source.tables();
        const sourceRows = new Map<string, readonly Record<string, unknown>[]>();
        for (const table of tables) sourceRows.set(table, await this.ports.source.rows(table));
        await this.ports.destination.withTransaction(entry.dbIdentifier, async writer => {
          for (const table of tables) await writer.copy(table, sourceRows.get(table)!);
        });
        for (const table of tables) {
          const original = sourceRows.get(table)!;
          const copied = await this.ports.destination.rows(entry.dbIdentifier, table);
          if (original.length !== copied.length || this.ports.hash.digest(original) !== this.ports.hash.digest(copied)) {
            throw new Error(`Legacy profile verification failed for ${table}`);
          }
        }
      });
      // Catalog completion then active pointer; the mapping is the final cutover action.
      const complete = new ProfileCatalogEntry({ cloudUserId, displayLabel, migrationState: 'complete' });
      await this.ports.catalog.completeAndActivate(complete);
      return complete;
    } catch (error) {
      let dropError: unknown;
      try { await this.ports.destination.drop(entry.dbIdentifier); } catch (failure) { dropError = failure; }
      await this.ports.catalog.setState(entry, 'failed');
      if (dropError !== undefined) {
        if (error instanceof Error) Object.defineProperty(error, 'cause', { value: dropError, configurable: true });
        throw error;
      }
      throw error;
    }
  }

  async rollback(legacyDatabaseIdentifier: string): Promise<void> {
    if (!this.enabled) throw new Error('Vault profile provisioning is disabled');
    if (!/^[_a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(legacyDatabaseIdentifier)) throw new Error('Invalid legacy database identifier');
    await this.ports.mapping.set(legacyDatabaseIdentifier);
  }
}
