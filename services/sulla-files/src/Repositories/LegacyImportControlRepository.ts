// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Envelope } from '../crypto.js';
import type pg from 'pg';

/**
 * Transaction boundaries, locks and the native master verifier for the legacy import.
 * The import runs its own isolation levels (REPEATABLE READ snapshots) and holds the
 * import advisory lock for the whole transaction, so it does not use TransactionRunner.
 */
export class LegacyImportControlRepository {
  static readonly IMPORT_LOCK = 'sulla-files-legacy-import';

  begin(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('BEGIN') }
  beginSnapshot(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('BEGIN ISOLATION LEVEL REPEATABLE READ') }
  beginReadOnlySnapshot(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') }
  commit(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('COMMIT') }
  rollback(client:pg.PoolClient):Promise<pg.QueryResult> { return client.query('ROLLBACK') }

  /** Serializes staging, publication and containment for the whole transaction. */
  lockImport(client:pg.PoolClient):Promise<pg.QueryResult> {
    return client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LegacyImportControlRepository.IMPORT_LOCK]);
  }

  lockPublicationTables(client:pg.PoolClient):Promise<pg.QueryResult> {
    return client.query('LOCK TABLE collections, files, file_versions, manifests, folder_shares, edges, journal, audit_log IN SHARE ROW EXCLUSIVE MODE');
  }

  async lockedMasterVerifier(client:pg.PoolClient):Promise<Envelope | undefined> {
    return (await client.query('SELECT verifier FROM files_key_state WHERE id=TRUE FOR UPDATE')).rows[0]?.verifier;
  }
}
