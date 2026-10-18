CREATE TABLE IF NOT EXISTS file_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK(principal_type IN('user','group')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('view','edit')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(file_id,principal_type,principal_id)
);

CREATE INDEX IF NOT EXISTS idx_file_shares_principal ON file_shares(principal_type,principal_id,file_id);
CREATE INDEX IF NOT EXISTS idx_file_shares_file ON file_shares(file_id);

CREATE TABLE IF NOT EXISTS file_share_chunk_uploads (
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_id UUID NOT NULL,
  chunk_collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes',
  PRIMARY KEY(version_id,chunk_id,principal_id)
);

CREATE INDEX IF NOT EXISTS idx_file_share_chunk_uploads_lookup
  ON file_share_chunk_uploads(chunk_collection_id,chunk_id,principal_id,expires_at);
