CREATE TABLE IF NOT EXISTS files_cloud_sync (
  collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version > 0),
  wrapped_root JSONB,
  last_seq BIGINT NOT NULL DEFAULT 0 CHECK(last_seq >= 0),
  head JSONB,
  status TEXT NOT NULL DEFAULT 'off' CHECK(status IN ('off','idle','syncing','error','needs-vault')),
  last_error TEXT,
  last_sync_at TIMESTAMPTZ,
  pending_bytes BIGINT NOT NULL DEFAULT 0 CHECK(pending_bytes >= 0),
  conflicts BIGINT NOT NULL DEFAULT 0 CHECK(conflicts >= 0),
  upload_session JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS files_cloud_chunk_map (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  local_chunk_id TEXT NOT NULL CHECK(local_chunk_id ~ '^[0-9a-f]{64}$'),
  cloud_chunk_id TEXT NOT NULL CHECK(cloud_chunk_id ~ '^[0-9a-f]{64}$'),
  cipher_sha256 TEXT NOT NULL CHECK(cipher_sha256 ~ '^[0-9a-f]{64}$'),
  cipher_bytes BIGINT NOT NULL CHECK(cipher_bytes > 0),
  uploaded_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  PRIMARY KEY(collection_id, local_chunk_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS files_cloud_chunk_map_cloud ON files_cloud_chunk_map(collection_id, cloud_chunk_id);

CREATE TABLE IF NOT EXISTS files_cloud_versions (
  version_id TEXT PRIMARY KEY REFERENCES file_versions(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  pushed_seq BIGINT CHECK(pushed_seq >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS files_cloud_versions_collection ON files_cloud_versions(collection_id, pushed_seq);

CREATE TABLE IF NOT EXISTS files_cloud_operations (
  handle UUID PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  op TEXT NOT NULL CHECK(op IN ('create','escrow','upload-open','commit','delete')),
  path TEXT NOT NULL,
  method TEXT NOT NULL,
  body JSONB,
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS files_cloud_operations_ready ON files_cloud_operations(created_at);

INSERT INTO file_sync_cursors(collection_id,device_id)
SELECT id,'cloud' FROM collections ON CONFLICT DO NOTHING;
