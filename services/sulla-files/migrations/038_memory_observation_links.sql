-- Durable memory files have one stable observation row. Additive only: Files
-- and observations retain their data independently if this feature rolls back.
ALTER TABLE observations ADD COLUMN IF NOT EXISTS file_id UUID REFERENCES files(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_memory_file
  ON observations(file_id) WHERE file_id IS NOT NULL;
