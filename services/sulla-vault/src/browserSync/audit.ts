// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Metadata-only audit for the vault origin, written to Vault's append-only
// audit_log. Allowed detail: counts, seq/generation/epoch, scope kind, reason
// codes and a keyed IP hash. Never names, hosts, URLs, per-item sizes or
// ciphertext.

import type { Queryable } from '../db.js';

export type BrowserSyncEvent =
  | 'browser_session_started' | 'browser_session_ended' | 'bundle_created' | 'bundle_rewrapped'
  | 'bundle_downloaded' | 'records_downloaded' | 'commit_accepted' | 'commit_conflict' | 'validator_rejected';

const PREFIX = 'browser_sync_';

type Detail = Record<string, string | number | boolean | null>;

export interface AuditEntry {
  userId:        string;
  orgId:         string;
  event:         BrowserSyncEvent;
  collectionId?: string | null;
  detail?:       Detail;
}

export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  try {
    await db.query(
      'INSERT INTO audit_log(actor_user_id, org_id, collection_id, action, metadata) VALUES ($1, $2, $3, $4, $5)',
      [entry.userId, entry.orgId, entry.collectionId ?? null, `${ PREFIX }${ entry.event }`, entry.detail ?? {}],
    );
  } catch (error) {
    // Auditing must never leak through a sync response; keep one short line for operators.
    console.warn('sulla-vault: browser sync audit write failed', (error as { code?: string })?.code ?? 'unknown');
  }
}

export interface AuditPage {
  events:     Array<{ id: string; actor: string; actorUserId: string; event: string; detail: unknown; at: string }>;
  nextBefore: string | null;
}

/**
 * Newest first. A member sees their own vault activity; owners and admins see
 * every member's, because they answer for the whole organization's vault.
 */
export async function listAudit(
  db: Queryable, member: { userId: string; orgId: string; role: string }, before: number | null,
): Promise<AuditPage> {
  const everyone = member.role === 'owner' || member.role === 'admin';
  const result = await db.query<{
    id:            string;
    actor_user_id: string;
    display_name:  string | null;
    action:        string;
    metadata:      unknown;
    created_at:    Date;
  }>(
    `SELECT a.id::text AS id, a.actor_user_id, u.display_name, a.action, a.metadata, a.created_at
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.org_id = $1 AND a.action LIKE 'browser\\_sync\\_%'
        AND ($2::boolean OR a.actor_user_id = $3)
        AND ($4::bigint IS NULL OR a.id < $4::bigint)
      ORDER BY a.id DESC
      LIMIT 100`,
    [member.orgId, everyone, member.userId, before],
  );
  const events = result.rows.map(row => ({
    id:          row.id,
    actor:       row.actor_user_id === member.userId ? 'browser' : `${ row.display_name || 'Member' } · browser`,
    actorUserId: row.actor_user_id,
    event:       row.action.slice(PREFIX.length),
    detail:      row.metadata ?? {},
    at:          row.created_at.toISOString(),
  }));
  return { events, nextBefore: events.length === 100 ? events[99].id : null };
}
