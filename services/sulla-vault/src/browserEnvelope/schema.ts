// Local bookkeeping for Passwords sync v3. Created on first use (idempotent),
// so the sync module stays self-contained inside the vault service.
//
// cloud_vault_sync_state    one row per local vault user: which Cloud vault,
//                           the highest verified head (anti-rollback), status.
// cloud_vault_sync_records  what Cloud holds for each local item: generation,
//                           tombstone flag, record MAC (to recompute the head
//                           over deltas) and the local revision it reflects.

import type { Queryable } from '../db.js';

export const SYNC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cloud_vault_sync_state (
  owner_user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vault_id          uuid NOT NULL,
  epoch             integer NOT NULL DEFAULT 1,
  bundle_generation integer NOT NULL DEFAULT 1,
  head_seq          bigint NOT NULL DEFAULT 0,
  head_mac          text NOT NULL DEFAULT '',
  last_push_at      timestamptz,
  last_pull_at      timestamptz,
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloud_vault_sync_records (
  owner_user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope                 text NOT NULL DEFAULT 'personal',
  record_id             uuid NOT NULL,
  generation            bigint NOT NULL,
  deleted               boolean NOT NULL,
  record_mac            text NOT NULL,
  local_revision        bigint,
  policy_review_pending boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_user_id, scope, record_id)
);
ALTER TABLE cloud_vault_sync_state ADD COLUMN IF NOT EXISTS bundle_sha text NOT NULL DEFAULT '';
`;

let ensured = false;

export async function ensureSyncSchema(db: Queryable): Promise<void> {
  if (ensured) return;
  await db.query(SYNC_SCHEMA_SQL);
  ensured = true;
}
