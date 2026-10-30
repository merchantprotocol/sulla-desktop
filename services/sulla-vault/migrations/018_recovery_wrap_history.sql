-- SPDX-License-Identifier: GPL-2.0-or-later
-- Additive restore points for recovery-wrap rotation. History is never used for normal unlock.
CREATE TABLE IF NOT EXISTS local_vault_recovery_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recovery_salt text NOT NULL,
  recovery_verifier text NOT NULL,
  encrypted_user_key jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN ('rotation')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS local_vault_recovery_history_user_created_idx
  ON local_vault_recovery_history(user_id, created_at DESC);
