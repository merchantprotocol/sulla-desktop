// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { Queryable } from '../db.js';
import { PostgresVaultProfileActivationRepository } from './PostgresVaultProfileActivationRepository.js';

/** Legacy active-database pointer adapter; values are bound parameters. */
export class LegacyProfileMappingAdapter {
  constructor(private readonly db: Queryable, private readonly activation: PostgresVaultProfileActivationRepository) {}
  async get(): Promise<string> {
    const result = await this.db.query<{ db_identifier: string }>('SELECT db_identifier FROM vault_profile_active WHERE singleton=true');
    if (result.rowCount !== 1 || !result.rows[0]) throw new Error('No active vault profile row exists');
    return result.rows[0].db_identifier;
  }
  async set(dbIdentifier: string): Promise<void> { await this.activation.setActiveDatabase(dbIdentifier); }
}
