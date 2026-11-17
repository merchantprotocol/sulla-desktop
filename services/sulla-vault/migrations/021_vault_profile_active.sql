-- SPDX-License-Identifier: GPL-2.0-or-later
-- Single active database pointer; application writes only after verified migration.
CREATE TABLE IF NOT EXISTS vault_profile_active (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  db_identifier text NOT NULL,
  profile_id text REFERENCES vault_profile_catalog(profile_id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
