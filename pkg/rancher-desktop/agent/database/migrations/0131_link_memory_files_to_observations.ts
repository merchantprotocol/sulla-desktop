/** Link durable Files memories to their deduplicated observation row. */
export const up = `
  ALTER TABLE observations ADD COLUMN IF NOT EXISTS file_id UUID REFERENCES files(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_memory_file
    ON observations(file_id) WHERE file_id IS NOT NULL;
`;

// Additive: observation/file provenance must survive a code rollback.
export const down = ``;
