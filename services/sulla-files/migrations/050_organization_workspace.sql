-- Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
-- Licensed under the Sulla Fair-Code License. See LICENSE.
--
-- Additive only: existing collections retain their principal scope and is_default value.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS workspace_scope TEXT NOT NULL DEFAULT 'principal';

ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_workspace_scope_check;
ALTER TABLE collections ADD CONSTRAINT collections_workspace_scope_check
  CHECK (workspace_scope IN ('principal', 'organization'));

CREATE UNIQUE INDEX IF NOT EXISTS collections_default_organization
  ON collections(org_id)
  WHERE workspace_scope='organization' AND is_default=TRUE AND published=TRUE AND legacy_source=FALSE;
