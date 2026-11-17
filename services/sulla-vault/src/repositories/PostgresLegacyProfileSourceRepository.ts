// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type pg from 'pg';
import type { Queryable } from '../db.js';
import { PgTransactionRunner, type TransactionPool } from './PgTransactionRunner.js';

const EXCLUDED = new Set(['vault_profile_catalog', 'vault_profile_active']);
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/** Captured state of one legacy public sequence; copied to the profile DB so later inserts keep ordering. */
export interface LegacySequenceState { readonly name: string; readonly lastValue: string | number; readonly isCalled: boolean }

/** Read-only legacy database adapter. Table names are discovered before interpolation. */
export class PostgresLegacyProfileSourceRepository {
  private transactionClient?: pg.PoolClient;
  private knownTables = new Set<string>();
  constructor(private readonly pool: Queryable & TransactionPool, private readonly transactions = new PgTransactionRunner()) {}

  async identifyOwner(): Promise<{ kdfCloudUserId?: string | null; activeAccountIds: readonly (string | null)[] }> {
    const users = await this.pool.query<{ cloud_user_id: string | null }>("SELECT kdf->>'cloudUserId' AS cloud_user_id FROM users ORDER BY id");
    const cloudIds = [...new Set(users.rows.map(row => row.cloud_user_id?.trim()).filter((id): id is string => Boolean(id)))];
    if (cloudIds.length > 1) throw new Error('Legacy vault has multiple Cloud owners');
    const cloud = cloudIds[0] ?? null;
    const active = await this.pool.query<{ active_account_id: string | null }>(
      "SELECT DISTINCT active_account_id FROM local_integration_state WHERE integration_id='sulla-cloud' AND active_account_id IS NOT NULL ORDER BY active_account_id",
    );
    return { kdfCloudUserId: cloud, activeAccountIds: active.rows.map(row => row.active_account_id) };
  }

  async tables(): Promise<readonly string[]> {
    const result = await this.queryable().query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
    );
    this.knownTables = new Set(result.rows.map(row => row.table_name).filter(name => !EXCLUDED.has(name) && IDENTIFIER.test(name)));
    return [...this.knownTables];
  }

  async rows(table: string): Promise<readonly Record<string, unknown>[]> {
    this.assertTable(table);
    const result = await this.queryable().query(`SELECT * FROM public."${table}"`);
    return result.rows;
  }

  /** Every public sequence with its current value. Only valid under the exclusive lock, so no writer can advance it. */
  async sequences(): Promise<readonly LegacySequenceState[]> {
    if (!this.transactionClient) throw new Error('Legacy sequences must be read under the exclusive lock');
    const names = await this.queryable().query<{ sequencename: string }>("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
    const states: LegacySequenceState[] = [];
    for (const row of names.rows) {
      if (!IDENTIFIER.test(row.sequencename)) throw new Error('Invalid legacy sequence identifier');
      const state = await this.queryable().query<{ last_value: string | number; is_called: boolean }>(`SELECT last_value, is_called FROM public."${row.sequencename}"`);
      states.push({ name: row.sequencename, lastValue: state.rows[0].last_value, isCalled: state.rows[0].is_called });
    }
    return states;
  }

  async withExclusiveReadLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactions.run(this.pool, async client => {
      this.transactionClient = client;
      try {
        const tables = await this.tables();
        for (const table of tables) { this.assertTable(table); await client.query(`LOCK TABLE public."${table}" IN EXCLUSIVE MODE`); }
        return await operation();
      } finally { this.transactionClient = undefined; }
    });
  }

  private queryable(): Queryable { return this.transactionClient ?? this.pool; }
  private assertTable(table: string): void {
    if (!IDENTIFIER.test(table) || EXCLUDED.has(table) || !this.knownTables.has(table)) throw new Error('Legacy table is not enumerated');
  }
}
