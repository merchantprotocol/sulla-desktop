// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { ProfileCatalogEntry, type ProfileCatalogEntry as Entry } from '@sulla/vault-profiles';
import { PostgresVaultProfileActivationRepository } from './PostgresVaultProfileActivationRepository.js';
import { PostgresVaultProfileCatalogRepository } from './PostgresVaultProfileCatalogRepository.js';

/** Adapts existing catalog repositories to the migration orchestration port. */
export class LegacyProfileCatalogAdapter {
  constructor(private readonly catalog: PostgresVaultProfileCatalogRepository, private readonly activation: PostgresVaultProfileActivationRepository) {}
  async entries(): Promise<Entry[]> {
    return (await this.catalog.list()).map((row: any) => new ProfileCatalogEntry({ cloudUserId: row.cloudUserId, displayLabel: row.displayLabel, migrationState: row.migrationState, generation: Number(row.generation) }));
  }
  async setState(entry: Entry, state: 'pending' | 'failed'): Promise<void> { await this.activation.setMigrationState(entry, state); }
  async completeAndActivate(entry: Entry): Promise<void> { await this.activation.completeAndActivate(entry); }
}
