ALTER TABLE items ADD COLUMN IF NOT EXISTS integration_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS items_integration_ref_active_idx
  ON items(integration_ref) WHERE integration_ref IS NOT NULL AND deleted_at IS NULL;
