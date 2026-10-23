-- Separate, explicit opt-in for pushing a collection's file catalog
-- (metadata only) to Sulla Cloud. Distinct from `home`, which governs
-- device-local sync behavior, not what the Cloud web dashboard sees.
-- Default false: nothing is pushed until the owner turns this on per
-- collection in the Desktop File Manager.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS cloud_catalog_sync BOOLEAN NOT NULL DEFAULT FALSE;
