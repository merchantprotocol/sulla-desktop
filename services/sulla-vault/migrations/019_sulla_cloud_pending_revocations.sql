-- SPDX-License-Identifier: GPL-2.0-or-later
-- Durable sign-out queue: refresh tokens whose server-side revoke (POST /auth/logout) could not be confirmed
-- (offline). Each token is encrypted with the vault user key (same envelope as an item); rows are deleted
-- once the server confirms. Additive: does not touch users.encrypted_user_key or the vault key format.
CREATE TABLE IF NOT EXISTS sulla_cloud_pending_revocations (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext jsonb NOT NULL,
  encrypted_item_key jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sulla_cloud_pending_revocations_owner_idx
  ON sulla_cloud_pending_revocations(owner_user_id, created_at);
