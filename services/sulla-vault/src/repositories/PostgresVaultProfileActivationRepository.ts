// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { ProfileBoundary, type ProfileCatalogEntry } from '@sulla/vault-profiles';
import type pg from 'pg';
import { PgTransactionRunner, type TransactionPool } from './PgTransactionRunner.js';

/** Transactional catalog state and single-active-profile pointer repository. */
export class PostgresVaultProfileActivationRepository {
  constructor(
    private readonly pool: TransactionPool,
    private readonly transactions = new PgTransactionRunner(),
    private readonly boundary = new ProfileBoundary(),
  ) {}

  async completeAndActivate(entry: ProfileCatalogEntry): Promise<void> {
    this.boundary.assertCollisionSafe([entry.toJSON()]);
    await this.transactions.run(this.pool, async (client: pg.PoolClient) => {
      await client.query(
        `INSERT INTO vault_profile_catalog(profile_id,cloud_user_id,db_identifier,display_label,migration_state,generation)
         VALUES ($1,$2,$3,$4,'complete',$5)
         ON CONFLICT (profile_id) DO UPDATE SET cloud_user_id=EXCLUDED.cloud_user_id,
         db_identifier=EXCLUDED.db_identifier,display_label=EXCLUDED.display_label,
         migration_state='complete',generation=EXCLUDED.generation,updated_at=now()`,
        [entry.profileId.value, entry.cloudUserId, entry.dbIdentifier, entry.displayLabel, entry.generation.value],
      );
      await client.query(
        `INSERT INTO vault_profile_active(singleton,db_identifier,profile_id) VALUES (true,$1,$2)
         ON CONFLICT (singleton) DO UPDATE SET db_identifier=EXCLUDED.db_identifier,
         profile_id=EXCLUDED.profile_id,updated_at=now()`,
        [entry.dbIdentifier, entry.profileId.value],
      );
    });
  }

  async setMigrationState(entry: ProfileCatalogEntry, state: 'pending' | 'failed'): Promise<void> {
    this.boundary.assertCollisionSafe([entry.toJSON()]);
    await this.pool.query(
      `INSERT INTO vault_profile_catalog(profile_id,cloud_user_id,db_identifier,display_label,migration_state,generation)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (profile_id) DO UPDATE SET migration_state=EXCLUDED.migration_state,updated_at=now()`,
      [entry.profileId.value, entry.cloudUserId, entry.dbIdentifier, entry.displayLabel, state, entry.generation.value],
    );
  }

  async setActiveDatabase(dbIdentifier: string): Promise<void> {
    // Legacy identifiers are also validated SQL identifiers; profile DBs use ProfileBoundary above.
    if (!/^[_a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(dbIdentifier)) throw new Error('Invalid database identifier');
    const result = await this.pool.query('UPDATE vault_profile_active SET db_identifier=$1,profile_id=NULL,updated_at=now() WHERE singleton=true', [dbIdentifier]);
    if (result.rowCount !== 1) throw new Error('No active vault profile row exists');
  }
}
