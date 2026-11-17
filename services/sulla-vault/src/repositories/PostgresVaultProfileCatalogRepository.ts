// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ProfileCatalogEntry } from '@sulla/vault-profiles';
import type { Queryable } from '../db.js';

/** SQL boundary for profile catalog metadata; Cloud IDs are always bound values. */
export class PostgresVaultProfileCatalogRepository {
  constructor(private readonly pool: Queryable) {}

  async list(): Promise<unknown[]> {
    const result = await this.pool.query(
      'SELECT profile_id AS "profileId", cloud_user_id AS "cloudUserId", db_identifier AS "dbIdentifier", display_label AS "displayLabel", migration_state AS "migrationState", generation FROM vault_profile_catalog ORDER BY profile_id',
    );
    return result.rows;
  }

  async register(entry: ProfileCatalogEntry): Promise<void> {
    await this.pool.query(
      'INSERT INTO vault_profile_catalog(profile_id, cloud_user_id, db_identifier, display_label, migration_state, generation) VALUES ($1, $2, $3, $4, $5, $6)',
      [entry.profileId.value, entry.cloudUserId, entry.dbIdentifier, entry.displayLabel, entry.migrationState, entry.generation.value],
    );
  }
}
