ALTER TABLE files ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE files ADD COLUMN IF NOT EXISTS metadata_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE file_folders ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE file_folders ADD COLUMN IF NOT EXISTS metadata_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_created_by_type_check;
ALTER TABLE files ADD CONSTRAINT files_created_by_type_check CHECK(created_by_type IN('user','agent-run','agent'));
ALTER TABLE file_versions DROP CONSTRAINT IF EXISTS file_versions_created_by_type_check;
ALTER TABLE file_versions ADD CONSTRAINT file_versions_created_by_type_check CHECK(created_by_type IN('user','agent-run','agent'));
CREATE INDEX IF NOT EXISTS idx_files_metadata ON files USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_file_folders_metadata ON file_folders USING GIN(metadata);

CREATE TABLE IF NOT EXISTS file_automerge_versions (
  version_id UUID PRIMARY KEY REFERENCES file_versions(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  document BYTEA NOT NULL,
  heads JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_file_automerge_versions_file ON file_automerge_versions(file_id,created_at DESC);

-- Any scratch collection containing a file row, even a tombstone, is retained.
DELETE FROM collections c
WHERE c.kind='scratch'
  AND NOT EXISTS (SELECT 1 FROM files f WHERE f.collection_id=c.id);
