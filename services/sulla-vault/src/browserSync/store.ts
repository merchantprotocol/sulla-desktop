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

import { CanonicalJson } from '@sulla/domain';

import type { BundleFields, SyncBundle } from '../browserEnvelope/VaultSyncContracts.js';
import { VaultSyncExportMapper } from '../browserEnvelope/VaultSyncExportMapper.js';

import type { Queryable } from '../db.js';

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
  return new VaultSyncExportMapper().bundleFields(account, { vaultId, epoch, bundleGeneration });
}

/** True when the browser's bundle carries exactly the account's wrapped keys and KDF. */
export function bundleMatchesAccount(bundle: SyncBundle, expected: BundleFields): boolean {
  const { format: _format, v: _v, mac: _mac, ...fields } = bundle;
  void _format;
  void _v;
  void _mac;
  const canonical = new CanonicalJson();
  return canonical.stringify(fields) === canonical.stringify(expected);
}

