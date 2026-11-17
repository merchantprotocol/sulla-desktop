-- SPDX-License-Identifier: GPL-2.0-or-later
-- Dark-launch profile metadata only. No credentials, keys, or existing-table changes.
CREATE TABLE IF NOT EXISTS vault_profile_catalog (
  profile_id text PRIMARY KEY,
  cloud_user_id text NOT NULL UNIQUE,
  db_identifier text NOT NULL UNIQUE,
  display_label text NOT NULL,
  migration_state text NOT NULL CHECK (migration_state IN ('unmigrated', 'pending', 'complete', 'failed')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
