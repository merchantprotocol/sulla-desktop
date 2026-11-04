// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { LIMITS, type CommitBody, type CreateBody } from '../browserSync/validator.js';
import type { Member, ScopeRef } from '../browserSync/store.js';
import type { SyncBundle, SyncHead, SyncRecord } from '../browserEnvelope/envelope.js';
import type { Database, Queryable } from '../db.js';

export interface VaultBundleRecord { epoch: number; bundle_generation: number; bundle: SyncBundle; updated_at: string }
export interface VaultHeadRecord { seq: number; head: SyncHead }
export interface VaultRecordRecord { seq: string; id: string; record: SyncRecord }
export interface VaultRecordPage { head: SyncHead | null; records: SyncRecord[]; nextCursor: string | null }
export type VaultCommitResult =
  | { ok: true; seq: number; written: number }
  | { ok: false; error: 'head_stale'; headSeq: number }
  | { ok: false; error: 'record_conflict'; conflicts: Array<{ id: string; generation: number }> }
  | { ok: false; error: 'too_many_records' };

class PostgresTransaction {
  constructor(private readonly db: Database) {}
  async run<T>(work: (client: Queryable) => Promise<T>, keep: (result: T) => boolean = () => true): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query(keep(result) ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

export class PostgresVaultBundleRepository {
  private readonly transaction: PostgresTransaction;
  constructor(private readonly db: Database) { this.transaction = new PostgresTransaction(db); }

  async findVaultId(orgId: string): Promise<string> {
    const select = 'SELECT vault_id FROM browser_sync_vaults WHERE org_id = $1';
    const existing = await this.db.query<{ vault_id: string }>(select, [orgId]);
    if (existing.rows[0]) return existing.rows[0].vault_id;
    await this.db.query('INSERT INTO browser_sync_vaults(org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING', [orgId]);
    const created = await this.db.query<{ vault_id: string }>(select, [orgId]);
    return created.rows[0].vault_id;
  }

  async find(vaultId: string, userId: string): Promise<VaultBundleRecord | null> {
    const result = await this.db.query<VaultBundleRecord>(
      `SELECT epoch, bundle_generation, bundle, updated_at
         FROM browser_sync_bundles WHERE vault_id = $1 AND user_id = $2`, [vaultId, userId]);
    return result.rows[0] ?? null;
  }

  async createPersonalVault(member: Member, vaultId: string, body: CreateBody): Promise<{ ok: true } | { ok: false; error: 'vault_exists' }> {
    return this.transaction.run(async(client) => {
      const inserted = await client.query(
        `INSERT INTO browser_sync_bundles(vault_id, user_id, epoch, bundle_generation, bundle)
         VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
        [vaultId, member.userId, body.bundle.epoch, body.bundle.bundleGeneration, JSON.stringify(body.bundle)]);
      if (!inserted.rowCount) return { ok: false, error: 'vault_exists' } as const;
      await client.query('DELETE FROM browser_sync_heads WHERE vault_id = $1 AND scope_owner = $2', [vaultId, member.userId]);
      await client.query(
        `INSERT INTO browser_sync_heads(vault_id, scope_owner, scope, seq, head)
         VALUES ($1, $2, 'personal', $3, $4::jsonb)`,
        [vaultId, member.userId, body.head.seq, JSON.stringify(body.head)]);
      await PostgresVaultRecordRepository.upsert(client, vaultId, member.userId, body.head.seq, body.records);
      return { ok: true } as const;
    }, result => result.ok);
  }

  async rewrap(member: Member, vaultId: string, bundle: SyncBundle, expectedBundleGeneration: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE browser_sync_bundles SET bundle = $1::jsonb, bundle_generation = $2, updated_at = now()
        WHERE vault_id = $3 AND user_id = $4 AND bundle_generation = $5 AND epoch = $6`,
      [JSON.stringify(bundle), bundle.bundleGeneration, vaultId, member.userId, expectedBundleGeneration, bundle.epoch]);
    return result.rowCount === 1;
  }
}

export class PostgresVaultHeadRepository {
  constructor(private readonly db: Queryable) {}
  async find(vaultId: string, scopeOwner: string): Promise<VaultHeadRecord | null> {
    const result = await this.db.query<{ seq: string; head: SyncHead }>(
      'SELECT seq, head FROM browser_sync_heads WHERE vault_id = $1 AND scope_owner = $2', [vaultId, scopeOwner]);
    const row = result.rows[0];
    return row ? { seq: Number(row.seq), head: row.head } : null;
  }
}

export class PostgresVaultRecordRepository {
  private readonly transaction: PostgresTransaction;
  constructor(private readonly db: Database) { this.transaction = new PostgresTransaction(db); }

  async scopeStats(vaultId: string, scopeOwner: string) {
    const result = await this.db.query<{ items: string; bytes: string; updated: string | null }>(
      `SELECT COUNT(*) FILTER (WHERE NOT deleted AND kind = 'item')::text AS items,
              COALESCE(SUM(size_bytes) FILTER (WHERE NOT deleted), 0)::text AS bytes,
              MAX(updated_at)::text AS updated
         FROM browser_sync_records WHERE vault_id = $1 AND scope_owner = $2`, [vaultId, scopeOwner]);
    const row = result.rows[0];
    return { itemCount: Number(row?.items ?? 0), bytes: Number(row?.bytes ?? 0), lastWriteAt: row?.updated ?? null };
  }

  static async upsert(db: Queryable, vaultId: string, scopeOwner: string, seq: number, records: SyncRecord[]): Promise<void> {
    for (const record of records) {
      const json = JSON.stringify(record);
      await db.query(
        `INSERT INTO browser_sync_records
           (vault_id, scope_owner, id, kind, generation, deleted, seq, size_bytes, record, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
         ON CONFLICT (vault_id, scope_owner, id) DO UPDATE SET
           kind = excluded.kind, generation = excluded.generation, deleted = excluded.deleted, seq = excluded.seq,
           size_bytes = excluded.size_bytes, record = excluded.record, updated_at = excluded.updated_at`,
        [vaultId, scopeOwner, record.id, record.kind, record.generation, record.deleted, seq, json.length, json]);
    }
  }

  async commit(vaultId: string, ref: ScopeRef, body: CommitBody): Promise<VaultCommitResult> {
    return this.transaction.run(async(client) => {
      const current = await client.query<{ seq: string; mac: string | null }>(
        `SELECT seq, head->>'mac' AS mac FROM browser_sync_heads WHERE vault_id = $1 AND scope_owner = $2 FOR UPDATE`,
        [vaultId, ref.scopeOwner]);
      const head = current.rows[0];
      if (!head) {
        if (body.expectedHeadSeq !== 0) return { ok: false, error: 'head_stale', headSeq: 0 } as const;
        const started = await client.query(
          `INSERT INTO browser_sync_heads(vault_id, scope_owner, scope, seq, head) VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT DO NOTHING`, [vaultId, ref.scopeOwner, ref.scope, body.head.seq, JSON.stringify(body.head)]);
        if (!started.rowCount) return { ok: false, error: 'head_stale', headSeq: 0 } as const;
      } else if (Number(head.seq) !== body.expectedHeadSeq || head.mac !== body.head.prevHeadMac) {
        return { ok: false, error: 'head_stale', headSeq: Number(head.seq) } as const;
      }
      const ids = body.writes.map(write => write.id);
      const stored = await client.query<{ id: string; generation: string }>(
        `SELECT id, generation FROM browser_sync_records
          WHERE vault_id = $1 AND scope_owner = $2 AND id = ANY($3::uuid[]) FOR UPDATE`, [vaultId, ref.scopeOwner, ids]);
      const generations = new Map(stored.rows.map(row => [row.id, Number(row.generation)]));
      const conflicts = body.writes.filter(write => (generations.get(write.id) ?? 0) !== write.baseGeneration)
        .map(write => ({ id: write.id, generation: generations.get(write.id) ?? 0 }));
      if (conflicts.length) return { ok: false, error: 'record_conflict', conflicts } as const;
      const created = body.writes.filter(write => !generations.has(write.id)).length;
      const count = await client.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM browser_sync_records WHERE vault_id = $1 AND scope_owner = $2', [vaultId, ref.scopeOwner]);
      if (Number(count.rows[0]?.n ?? 0) + created > LIMITS.recordsPerScope) return { ok: false, error: 'too_many_records' } as const;
      await PostgresVaultRecordRepository.upsert(client, vaultId, ref.scopeOwner, body.head.seq, body.writes.map(write => write.record));
      await client.query(
        `UPDATE browser_sync_heads SET seq = $1, head = $2::jsonb, updated_at = now()
          WHERE vault_id = $3 AND scope_owner = $4`, [body.head.seq, JSON.stringify(body.head), vaultId, ref.scopeOwner]);
      return { ok: true, seq: body.head.seq, written: body.writes.length } as const;
    }, result => result.ok);
  }

  async list(vaultId: string, scopeOwner: string, since: number, cursor: { seq: number; id: string } | null, limit: number): Promise<VaultRecordPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('limit must be between 1 and 500');
    const head = await new PostgresVaultHeadRepository(this.db).find(vaultId, scopeOwner);
    if (!head) return { head: null, records: [], nextCursor: null };
    const after = cursor ?? { seq: since, id: '00000000-0000-0000-0000-000000000000' };
    const result = await this.db.query<VaultRecordRecord>(
      `SELECT seq, id, record FROM browser_sync_records
        WHERE vault_id = $1 AND scope_owner = $2 AND seq > $3 AND seq <= $4
          AND (seq > $5 OR (seq = $5 AND id > $6::uuid))
        ORDER BY seq, id LIMIT $7`, [vaultId, scopeOwner, since, head.seq, after.seq, after.id, limit + 1]);
    const page = result.rows.slice(0, limit);
    const last = page[page.length - 1];
    return { head: head.head, records: page.map(row => row.record), nextCursor: result.rows.length > limit && last ? `${last.seq}:${last.id}` : null };
  }
}
