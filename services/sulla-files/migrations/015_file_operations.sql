CREATE TABLE IF NOT EXISTS file_stars (
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'agent')),
  principal_id TEXT NOT NULL,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  folder_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((file_id IS NOT NULL) <> (folder_path IS NOT NULL)),
  CHECK (folder_path IS NULL OR (folder_path <> '' AND folder_path !~ '(^|/)[.][.]?($|/)'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_stars_file ON file_stars(principal_type,principal_id,file_id) WHERE file_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_stars_folder ON file_stars(principal_type,principal_id,collection_id,folder_path) WHERE folder_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_stars_principal ON file_stars(principal_type,principal_id,collection_id);

