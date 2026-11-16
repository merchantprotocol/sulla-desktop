// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

import type { Database } from '../db.js';

/**
 * Transaction control and the two integration-state reads that LocalVaultAuthority issued
 * directly. Moved verbatim from localAuthority.ts (E9): same SQL text, same statement order,
 * same ROLLBACK error handling, so callers keep their exact transaction boundaries.
 */
export class PostgresLocalAuthorityRepository {
  constructor(private readonly db: Database) {}

  /** One BEGIN … COMMIT unit on a pooled client; a failed ROLLBACK is swallowed so the original error surfaces. */
  async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  begin(client: pg.PoolClient): Promise<unknown> { return client.query('BEGIN') }

  beginReadOnly(client: pg.PoolClient): Promise<unknown> { return client.query('BEGIN READ ONLY') }

  commit(client: pg.PoolClient): Promise<unknown> { return client.query('COMMIT') }

  /** ROLLBACK whose failure propagates (callers that never swallowed it). */
  rollback(client: pg.PoolClient): Promise<unknown> { return client.query('ROLLBACK') }

  /** Serializes legacy credential imports across vault processes for the current transaction. */
  lockLegacyImport(client: pg.PoolClient): Promise<unknown> {
    return client.query("SELECT pg_advisory_xact_lock(hashtext('sulla-vault-legacy-import'))");
  }

  /** The Sulla Cloud account this vault was last signed in to, if any. */
  findPriorSullaCloudAccount<T extends QueryResultRow = QueryResultRow>(ownerUserId: string): Promise<QueryResult<T>> {
    return this.db.query<T>(
      `SELECT active_account_id FROM local_integration_state
          WHERE owner_user_id=$1 AND integration_id='sulla-cloud' LIMIT 1`, [ownerUserId],
    );
  }

  /** The active account chosen for one integration. */
  findActiveAccount<T extends QueryResultRow = QueryResultRow>(ownerUserId: string, integrationId: string): Promise<QueryResult<T>> {
    return this.db.query<T>(
      'SELECT active_account_id FROM local_integration_state WHERE owner_user_id=$1 AND integration_id=$2',
      [ownerUserId, integrationId],
    );
  }
}
