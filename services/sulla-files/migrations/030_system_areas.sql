ALTER TABLE collections ADD COLUMN IF NOT EXISTS system_area TEXT NULL;

DO $$ BEGIN
  ALTER TABLE collections ADD CONSTRAINT collections_system_area_valid
    CHECK (system_area IS NULL OR system_area IN ('logs','training-data','sulla'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS collections_system_area_unique
  ON collections(system_area) WHERE system_area IS NOT NULL;
