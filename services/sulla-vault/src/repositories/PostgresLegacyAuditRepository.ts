// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from '../db.js';

export interface LegacyAuditBatch { deleted: number; lastId: number }

/**
 * Storage for the one-time sweep of legacy audit rows: a keyset-paged batch delete of one
 * action, plus the vault_schema_migrations marker that records the sweep as finished.
 */
export class PostgresLegacyAuditRepository {
  constructor(private readonly client: Queryable) {}

  async isSwept(marker: string): Promise<boolean> {
    const done = await this.client.query('SELECT 1 FROM vault_schema_migrations WHERE version = $1', [marker]);
    return done.rows.length > 0;
  }

  /** Deletes up to `batchSize` rows of `action` with id > `afterId`; `lastId` is the highest id removed (or `afterId`). */
  async deleteBatch(action: string, afterId: number, batchSize: number): Promise<LegacyAuditBatch> {
    const result = await this.client.query(
      `WITH victims AS (
         SELECT id FROM audit_log WHERE action = $1 AND id > $2 ORDER BY id LIMIT $3
       ), gone AS (
         DELETE FROM audit_log a USING victims v WHERE a.id = v.id RETURNING a.id
       )
       SELECT count(*)::int AS n, COALESCE(max(id), $2)::bigint AS last FROM gone`,
      [action, afterId, batchSize],
    );
    const row = result.rows[0] as { n?: unknown; last?: unknown } | undefined;
    return { deleted: Number(row?.n ?? 0), lastId: Number(row?.last ?? afterId) };
  }

  async markSwept(marker: string): Promise<void> {
    await this.client.query('INSERT INTO vault_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [marker]);
  }
}
