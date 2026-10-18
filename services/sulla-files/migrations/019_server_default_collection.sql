ALTER TABLE collections ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS collections_default_owner_org
  ON collections(org_id,owner_user_id)
  WHERE is_default=TRUE AND published=TRUE AND legacy_source=FALSE;
