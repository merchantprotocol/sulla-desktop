// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from './db.js';
import type { PostgresLegacyAuditRepository } from './repositories/PostgresLegacyAuditRepository.js';
import { VaultRepositories } from './repositories/VaultRepositories.js';

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
 */
export class LegacyOutboundAuditPruner {
  static readonly MARKER = 'cleanup_vault_outbound_audit_rows';
  static readonly LEGACY_ACTION = 'vault_outbound_request';

  private readonly batchSize: number;
  private readonly pauseMs: number;
  private readonly maxBatches: number;
  private readonly log: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly audit: PostgresLegacyAuditRepository, options: PruneOptions = {}) {
    this.batchSize = Math.min(Math.max(options.batchSize ?? 5000, 1), 20_000);
    this.pauseMs = options.pauseMs ?? 50;
    this.maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
    this.log = options.log ?? ((message) => console.log(message));
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  }

  /** Runs (or resumes) the sweep. Returns rows deleted by this call. */
  async prune(): Promise<number> {
    const { MARKER, LEGACY_ACTION } = LegacyOutboundAuditPruner;
    if (await this.audit.isSwept(MARKER)) return 0;

    let cursor = 0;
    let deleted = 0;
    for (let batch = 0; batch < this.maxBatches; batch++) {
      const { deleted: n, lastId } = await this.audit.deleteBatch(LEGACY_ACTION, cursor, this.batchSize);
      if (n === 0) {
        await this.audit.markSwept(MARKER);
        this.log(`sulla-vault: removed ${ deleted } legacy ${ LEGACY_ACTION } audit rows from Postgres; run VACUUM (ANALYZE) audit_log to reclaim the space`);
        return deleted;
      }
      deleted += n;
      cursor = lastId;
      if (batch % 100 === 99) this.log(`sulla-vault: audit cleanup removed ${ deleted } legacy rows so far`);
      await this.sleep(this.pauseMs);
    }
    this.log(`sulla-vault: audit cleanup paused after ${ deleted } rows; it resumes on next start`);
    return deleted;
  }
}

/** @deprecated Use `new LegacyOutboundAuditPruner(VaultRepositories.createLegacyAuditRepository(db), options).prune()`. */
export function pruneLegacyOutboundAuditRows(db: Queryable, options: PruneOptions = {}): Promise<number> {
  return new LegacyOutboundAuditPruner(VaultRepositories.createLegacyAuditRepository(db), options).prune();
}
