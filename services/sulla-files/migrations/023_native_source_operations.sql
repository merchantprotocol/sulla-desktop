-- Durable bridge state for exact native source handles. Host paths and
-- capabilities never enter Files storage.
CREATE TABLE files_native_source_operations (
  operation_id UUID PRIMARY KEY,
  source_handle TEXT NOT NULL CHECK(source_handle ~ '^[A-Za-z0-9_-]{43}$'),
  direction TEXT NOT NULL CHECK(direction IN('ingest','publish')),
  state TEXT NOT NULL CHECK(state IN('planned','publishing','completed','recovery-required')),
  source_revision TEXT NOT NULL CHECK(source_revision ~ '^[a-f0-9]{64}$'),
  next_source_revision TEXT CHECK(next_source_revision IS NULL OR next_source_revision ~ '^[a-f0-9]{64}$'),
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  files_base_version_id UUID REFERENCES file_versions(id) ON DELETE SET NULL,
  files_version_id UUID,
  desired_hash TEXT CHECK(desired_hash IS NULL OR desired_hash ~ '^[a-f0-9]{64}$'),
  recovery JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(recovery)='object'),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX files_native_source_operations_pending
  ON files_native_source_operations(updated_at)
  WHERE state NOT IN('completed');
