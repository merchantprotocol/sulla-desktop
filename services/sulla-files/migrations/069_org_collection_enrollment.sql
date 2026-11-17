-- SPDX-License-Identifier: GPL-2.0-or-later
-- Local enrollment metadata for cloud-owned organization collections.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS org_collection_level TEXT NOT NULL DEFAULT 'none'
  CHECK (org_collection_level IN ('none','view','edit','manage'));
ALTER TABLE collections ADD COLUMN IF NOT EXISTS org_name TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS cloud_creator_user_id TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS root_key_source TEXT NOT NULL DEFAULT 'local'
  CHECK (root_key_source IN ('local','org'));
ALTER TABLE collections ADD COLUMN IF NOT EXISTS org_collection_enrolled BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS collections_org_enrolled
  ON collections(org_id,org_collection_enrolled) WHERE workspace_scope='organization';
