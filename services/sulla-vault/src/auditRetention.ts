// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from './db.js';

const MARKER = 'cleanup_vault_outbound_audit_rows';
const LEGACY_ACTION = 'vault_outbound_request';

export interface PruneOptions {
  batchSize?: number;
  pauseMs?: number;
  /** Safety valve: stop after this many batches (resumes on next start). */
  maxBatches?: number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Removes legacy `vault_outbound_request` rows from audit_log in small
 * keyset-paged batches (each its own short transaction, no table lock, memory
 * bounded by batchSize). Idempotent: a marker row in vault_schema_migrations is
 * written once the sweep completes; an interrupted sweep simply resumes.
 * Only that one action is deletable (the append-only trigger allows nothing
 * else). Does NOT vacuum: run `VACUUM (ANALYZE) audit_log` afterwards to reuse
 * the space, or `VACUUM FULL` in a maintenance window to return it to the OS.
 * Returns rows deleted.
 */
export async function pruneLegacyOutboundAuditRows(db: Queryable, options: PruneOptions = {}): Promise<number> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 5000, 1), 20_000);
  const pauseMs = options.pauseMs ?? 50;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  const log = options.log ?? ((message) => console.log(message));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));

  const done = await db.query('SELECT 1 FROM vault_schema_migrations WHERE version = $1', [MARKER]);
  if (done.rows.length) return 0;

  let cursor = 0;
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await db.query(
      `WITH victims AS (
         SELECT id FROM audit_log WHERE action = $1 AND id > $2 ORDER BY id LIMIT $3
       ), gone AS (
         DELETE FROM audit_log a USING victims v WHERE a.id = v.id RETURNING a.id
       )
       SELECT count(*)::int AS n, COALESCE(max(id), $2)::bigint AS last FROM gone`,
      [LEGACY_ACTION, cursor, batchSize],
    );
    const n = Number(result.rows[0]?.n ?? 0);
    if (n === 0) {
      await db.query('INSERT INTO vault_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [MARKER]);
      log(`sulla-vault: removed ${ deleted } legacy ${ LEGACY_ACTION } audit rows from Postgres; run VACUUM (ANALYZE) audit_log to reclaim the space`);
      return deleted;
    }
    deleted += n;
    cursor = Number(result.rows[0].last);
    if (batch % 100 === 99) log(`sulla-vault: audit cleanup removed ${ deleted } legacy rows so far`);
    await sleep(pauseMs);
  }
  log(`sulla-vault: audit cleanup paused after ${ deleted } rows; it resumes on next start`);
  return deleted;
}
