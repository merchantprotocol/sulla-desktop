-- Durable index for native sources. Files stores only the opaque Electron
-- handle and verification metadata; host paths and capabilities stay outside
-- the service and its database.
CREATE TABLE files_native_sources (
  source_handle TEXT PRIMARY KEY CHECK(source_handle ~ '^[A-Za-z0-9_-]{43}$'),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  file_id UUID NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  source_revision TEXT NOT NULL CHECK(source_revision ~ '^[a-f0-9]{64}$'),
  source_hash TEXT NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN('active','conflict','reselect-required','revoked')),
  recovery JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(recovery)='object'),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX files_native_sources_collection ON files_native_sources(collection_id, display_name);

-- A stale FUSE write can lose its source race before Electron creates a native
-- conflict handle. Keep that write as an encrypted, Files-only mount entry so
-- the losing bytes remain visible instead of disappearing behind EIO.
CREATE TABLE files_native_conflicts (
  file_id UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  source_file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX files_native_conflicts_source ON files_native_conflicts(source_file_id, created_at);
