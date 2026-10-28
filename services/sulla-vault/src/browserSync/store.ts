// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Postgres storage for the org vault behind /cloud-vault-sync/*. Opaque
// ciphertext rows plus the counters the server enforces: per-record generation
// and per-scope head seq. Commits are compare-and-swap inside one transaction,
// so a conflicting commit writes nothing.
//
// Access is decided here from Vault's own membership tables on every call:
// confirmed org membership for the vault, and the collection `view`/`edit`
// rights (direct or through a group, owners and admins implicitly) for a
// collection scope. A scope the caller can't read is reported as not found.

import { bundleFields } from '../browserEnvelope/exportBuilder.js';
import { jcs, type SyncBundle, type SyncHead, type SyncRecord } from '../browserEnvelope/envelope.js';
import { LIMITS, type CommitBody, type CreateBody } from './validator.js';

import type { Database, Queryable } from '../db.js';

export interface Member {
  userId: string;
  orgId:  string;
  role:   'owner' | 'admin' | 'member';
}

export interface CollectionAccess {
  collectionId:         string;
  encryptedName:        unknown;
  wrappedCollectionKey: unknown;
  canView:              boolean;
  canEdit:              boolean;
  canManage:            boolean;
}

/** A scope the caller resolved: where its rows live and whether they may write. */
export interface ScopeRef {
  scope:      string;
  scopeOwner: string;
  writable:   boolean;
}

export type CommitResult =
  | { ok: true; seq: number; written: number }
  | { ok: false; error: 'head_stale'; headSeq: number }
  | { ok: false; error: 'record_conflict'; conflicts: Array<{ id: string; generation: number }> }
  | { ok: false; error: 'too_many_records' };

interface AccountRow {
  id:                    string;
  public_key:            string;
  encrypted_private_key: unknown;
  encrypted_user_key:    unknown;
  kdf:                   unknown;
}

/** Confirmed, enabled membership of one Vault organization, or null. */
export async function findMember(db: Queryable, userId: string, orgId: string): Promise<Member | null> {
  const result = await db.query<{ role: Member['role'] }>(
    `SELECT om.role
       FROM org_members om
       JOIN users u ON u.id = om.user_id AND u.disabled_at IS NULL
      WHERE om.org_id = $1 AND om.user_id = $2 AND om.status = 'confirmed'`,
    [orgId, userId],
  );
  const role = result.rows[0]?.role;
  return role ? { userId, orgId, role } : null;
}

/** The org vault id, created on first use. */
export async function orgVaultId(db: Queryable, orgId: string): Promise<string> {
  const select = 'SELECT vault_id FROM browser_sync_vaults WHERE org_id = $1';
  const existing = await db.query<{ vault_id: string }>(select, [orgId]);
  if (existing.rows[0]) return existing.rows[0].vault_id;
  await db.query('INSERT INTO browser_sync_vaults(org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING', [orgId]);
  const created = await db.query<{ vault_id: string }>(select, [orgId]);
  return created.rows[0].vault_id;
}

/**
 * Collections in the member's org with their rights. Only rows the member may
 * view are returned, so callers can't accidentally hand out another key.
 */
export async function readableCollections(
  db: Queryable, member: Member, collectionId?: string,
): Promise<CollectionAccess[]> {
  const result = await db.query<{
    id:                     string;
    encrypted_name:         unknown;
    wrapped_collection_key: unknown;
    can_view:               boolean;
    can_edit:               boolean;
    can_manage:             boolean;
  }>(
    `WITH rights AS (
       SELECT c.id, c.encrypted_name, c.wrapped_collection_key,
              om.role IN ('owner', 'admin') AS manager,
              COALESCE(cm.can_view, false) OR EXISTS (
                SELECT 1 FROM group_members gm
                  JOIN collection_group_members cgm ON cgm.group_id = gm.group_id
                  JOIN org_groups g ON g.id = gm.group_id AND g.org_id = c.org_id
                 WHERE gm.user_id = $1 AND cgm.collection_id = c.id AND cgm.can_view) AS can_view,
              COALESCE(cm.can_edit, false) OR EXISTS (
                SELECT 1 FROM group_members gm
                  JOIN collection_group_members cgm ON cgm.group_id = gm.group_id
                  JOIN org_groups g ON g.id = gm.group_id AND g.org_id = c.org_id
                 WHERE gm.user_id = $1 AND cgm.collection_id = c.id AND cgm.can_edit) AS can_edit,
              COALESCE(cm.can_manage, false) OR EXISTS (
                SELECT 1 FROM group_members gm
                  JOIN collection_group_members cgm ON cgm.group_id = gm.group_id
                  JOIN org_groups g ON g.id = gm.group_id AND g.org_id = c.org_id
                 WHERE gm.user_id = $1 AND cgm.collection_id = c.id AND cgm.can_manage) AS can_manage
         FROM collections c
         JOIN org_members om ON om.org_id = c.org_id AND om.user_id = $1 AND om.status = 'confirmed'
         LEFT JOIN collection_members cm ON cm.collection_id = c.id AND cm.user_id = $1
        WHERE c.org_id = $2 AND ($3::uuid IS NULL OR c.id = $3::uuid)
     )
     SELECT id, encrypted_name, wrapped_collection_key,
            manager OR can_view AS can_view,
            manager OR can_edit AS can_edit,
            manager OR can_manage AS can_manage
       FROM rights
      WHERE manager OR can_view
      ORDER BY id`,
    [member.userId, member.orgId, collectionId ?? null],
  );
  return result.rows.map(row => ({
    collectionId:         row.id,
    encryptedName:        row.encrypted_name,
    wrappedCollectionKey: row.wrapped_collection_key,
    canView:              row.can_view,
    canEdit:              row.can_edit,
    canManage:            row.can_manage,
  }));
}

/** Resolve `personal` or a collection id to its storage key, or null when the member can't read it. */
export async function resolveScope(db: Queryable, member: Member, scope: string): Promise<ScopeRef | null> {
  if (scope === 'personal') return { scope, scopeOwner: member.userId, writable: true };
  const [collection] = await readableCollections(db, member, scope);
  if (!collection) return null;
  return { scope, scopeOwner: collection.collectionId, writable: collection.canEdit };
}

/** The bundle fields the server expects for this member: their account's wrapped keys, unsigned. */
export async function expectedBundleFields(
  db: Queryable, member: Member, vaultId: string, bundleGeneration: number, epoch = 1,
) {
  const result = await db.query<AccountRow>(
    `SELECT id, public_key, encrypted_private_key, encrypted_user_key, kdf
       FROM users WHERE id = $1 AND disabled_at IS NULL`,
    [member.userId],
  );
  const account = result.rows[0];
  if (!account) return null;
  return bundleFields(account, { vaultId, epoch, bundleGeneration });
}

/** True when the browser's bundle carries exactly the account's wrapped keys and KDF. */
export function bundleMatchesAccount(bundle: SyncBundle, expected: ReturnType<typeof bundleFields>): boolean {
  const { format: _format, v: _v, mac: _mac, ...fields } = bundle;
  void _format;
  void _v;
  void _mac;
  return jcs(fields) === jcs(expected);
}

export interface BundleRow { epoch: number; bundle_generation: number; bundle: SyncBundle; updated_at: string }

export async function getBundle(db: Queryable, vaultId: string, userId: string): Promise<BundleRow | null> {
  const result = await db.query<BundleRow>(
    `SELECT epoch, bundle_generation, bundle, updated_at
       FROM browser_sync_bundles WHERE vault_id = $1 AND user_id = $2`,
    [vaultId, userId],
  );
  return result.rows[0] ?? null;
}

export async function getHead(
  db: Queryable, vaultId: string, scopeOwner: string,
): Promise<{ seq: number; head: SyncHead } | null> {
  const result = await db.query<{ seq: string; head: SyncHead }>(
    'SELECT seq, head FROM browser_sync_heads WHERE vault_id = $1 AND scope_owner = $2',
    [vaultId, scopeOwner],
  );
  const row = result.rows[0];
  return row ? { seq: Number(row.seq), head: row.head } : null;
}

export async function scopeStats(db: Queryable, vaultId: string, scopeOwner: string) {
  const result = await db.query<{ items: string; bytes: string; updated: string | null }>(
    `SELECT COUNT(*) FILTER (WHERE NOT deleted AND kind = 'item')::text AS items,
            COALESCE(SUM(size_bytes) FILTER (WHERE NOT deleted), 0)::text AS bytes,
            MAX(updated_at)::text AS updated
       FROM browser_sync_records WHERE vault_id = $1 AND scope_owner = $2`,
    [vaultId, scopeOwner],
  );
  const row = result.rows[0];
  return { itemCount: Number(row?.items ?? 0), bytes: Number(row?.bytes ?? 0), lastWriteAt: row?.updated ?? null };
}

async function upsertRecords(db: Queryable, vaultId: string, scopeOwner: string, seq: number, records: SyncRecord[]) {
  for (const record of records) {
    const json = JSON.stringify(record);
    await db.query(
      `INSERT INTO browser_sync_records
         (vault_id, scope_owner, id, kind, generation, deleted, seq, size_bytes, record, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
       ON CONFLICT (vault_id, scope_owner, id) DO UPDATE SET
         kind = excluded.kind, generation = excluded.generation, deleted = excluded.deleted, seq = excluded.seq,
         size_bytes = excluded.size_bytes, record = excluded.record, updated_at = excluded.updated_at`,
      [vaultId, scopeOwner, record.id, record.kind, record.generation, record.deleted, seq, json.length, json],
    );
  }
}

/** Run `work` in one transaction. It commits only when `keep(result)` is true; otherwise nothing is written. */
async function inTransaction<T>(
  db: Database, work: (client: Queryable) => Promise<T>, keep: (result: T) => boolean = () => true,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query(keep(result) ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** First enrollment: the member's bundle plus their personal scope's first head. */
export async function createPersonalVault(
  db: Database, member: Member, vaultId: string, body: CreateBody,
): Promise<{ ok: true } | { ok: false; error: 'vault_exists' }> {
  return inTransaction(db, async(client) => {
    const inserted = await client.query(
      `INSERT INTO browser_sync_bundles(vault_id, user_id, epoch, bundle_generation, bundle)
       VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
      [vaultId, member.userId, body.bundle.epoch, body.bundle.bundleGeneration, JSON.stringify(body.bundle)],
    );
    if (!inserted.rowCount) return { ok: false, error: 'vault_exists' } as const;
    // A personal head left by an earlier enrollment (bundle since removed) is replaced with the new chain.
    await client.query(
      'DELETE FROM browser_sync_heads WHERE vault_id = $1 AND scope_owner = $2',
      [vaultId, member.userId],
    );
    await client.query(
      `INSERT INTO browser_sync_heads(vault_id, scope_owner, scope, seq, head)
       VALUES ($1, $2, 'personal', $3, $4::jsonb)`,
      [vaultId, member.userId, body.head.seq, JSON.stringify(body.head)],
    );
    await upsertRecords(client, vaultId, member.userId, body.head.seq, body.records);
    return { ok: true } as const;
  }, result => result.ok);
}

/** Password or KDF change: swap the bundle with CAS on bundleGeneration. */
export async function rewrapBundle(
  db: Queryable, member: Member, vaultId: string, bundle: SyncBundle, expectedBundleGeneration: number,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE browser_sync_bundles SET bundle = $1::jsonb, bundle_generation = $2, updated_at = now()
      WHERE vault_id = $3 AND user_id = $4 AND bundle_generation = $5 AND epoch = $6`,
    [JSON.stringify(bundle), bundle.bundleGeneration, vaultId, member.userId, expectedBundleGeneration, bundle.epoch],
  );
  return result.rowCount === 1;
}

/**
 * Atomic CAS commit for one scope. The stored head seq and MAC must equal what
 * the client built on, every write's baseGeneration must equal the stored
 * generation (0 = new id), and the scope must stay under its record cap.
 * A collection's first commit (expectedHeadSeq 0, no head yet) starts its chain.
 */
export async function commit(db: Database, vaultId: string, ref: ScopeRef, body: CommitBody): Promise<CommitResult> {
  return inTransaction(db, async(client) => {
    const current = await client.query<{ seq: string; mac: string | null }>(
      `SELECT seq, head->>'mac' AS mac FROM browser_sync_heads WHERE vault_id = $1 AND scope_owner = $2 FOR UPDATE`,
      [vaultId, ref.scopeOwner],
    );
    const head = current.rows[0];
    if (!head) {
      if (body.expectedHeadSeq !== 0) return { ok: false, error: 'head_stale', headSeq: 0 } as const;
      const started = await client.query(
        `INSERT INTO browser_sync_heads(vault_id, scope_owner, scope, seq, head) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT DO NOTHING`,
        [vaultId, ref.scopeOwner, ref.scope, body.head.seq, JSON.stringify(body.head)],
      );
      if (!started.rowCount) return { ok: false, error: 'head_stale', headSeq: 0 } as const;
    } else if (Number(head.seq) !== body.expectedHeadSeq || head.mac !== body.head.prevHeadMac) {
      return { ok: false, error: 'head_stale', headSeq: Number(head.seq) } as const;
    }
    const ids = body.writes.map(write => write.id);
    const stored = await client.query<{ id: string; generation: string }>(
      `SELECT id, generation FROM browser_sync_records
        WHERE vault_id = $1 AND scope_owner = $2 AND id = ANY($3::uuid[]) FOR UPDATE`,
      [vaultId, ref.scopeOwner, ids],
    );
    const generations = new Map(stored.rows.map(row => [row.id, Number(row.generation)]));
    const conflicts = body.writes
      .filter(write => (generations.get(write.id) ?? 0) !== write.baseGeneration)
      .map(write => ({ id: write.id, generation: generations.get(write.id) ?? 0 }));
    if (conflicts.length) {
      return { ok: false, error: 'record_conflict', conflicts } as const;
    }
    const created = body.writes.filter(write => !generations.has(write.id)).length;
    const count = await client.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM browser_sync_records WHERE vault_id = $1 AND scope_owner = $2',
      [vaultId, ref.scopeOwner],
    );
    if (Number(count.rows[0]?.n ?? 0) + created > LIMITS.recordsPerScope) {
      return { ok: false, error: 'too_many_records' } as const;
    }
    await upsertRecords(client, vaultId, ref.scopeOwner, body.head.seq, body.writes.map(write => write.record));
    await client.query(
      `UPDATE browser_sync_heads SET seq = $1, head = $2::jsonb, updated_at = now()
        WHERE vault_id = $3 AND scope_owner = $4`,
      [body.head.seq, JSON.stringify(body.head), vaultId, ref.scopeOwner],
    );
    return { ok: true, seq: body.head.seq, written: body.writes.length } as const;
  }, result => result.ok);
}

/** Records written after `since` (up to the head read first), keyset-paged by (seq, id). */
export async function listRecords(
  db: Queryable,
  vaultId: string,
  scopeOwner: string,
  since: number,
  cursor: { seq: number; id: string } | null,
  limit: number,
): Promise<{ head: SyncHead | null; records: SyncRecord[]; nextCursor: string | null }> {
  const head = await getHead(db, vaultId, scopeOwner);
  if (!head) return { head: null, records: [], nextCursor: null };
  const after = cursor ?? { seq: since, id: '00000000-0000-0000-0000-000000000000' };
  const result = await db.query<{ seq: string; id: string; record: SyncRecord }>(
    `SELECT seq, id, record FROM browser_sync_records
      WHERE vault_id = $1 AND scope_owner = $2 AND seq > $3 AND seq <= $4
        AND (seq > $5 OR (seq = $5 AND id > $6::uuid))
      ORDER BY seq, id LIMIT $7`,
    [vaultId, scopeOwner, since, head.seq, after.seq, after.id, limit + 1],
  );
  const page = result.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    head:       head.head,
    records:    page.map(row => row.record),
    nextCursor: result.rows.length > limit && last ? `${ last.seq }:${ last.id }` : null,
  };
}
