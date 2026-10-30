-- SPDX-License-Identifier: GPL-2.0-or-later
-- Additive local restore points. Rows contain wrapped keys/KDF metadata only.
CREATE TABLE IF NOT EXISTS local_vault_wrap_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_hash_salt bytea NOT NULL,
  login_hash_verifier bytea NOT NULL,
  encrypted_user_key jsonb NOT NULL,
  kdf jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN ('account_password_migration', 'cloud_rewrap', 'password_change', 'recovery')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS local_vault_wrap_history_user_created_idx
  ON local_vault_wrap_history(user_id, created_at DESC);
