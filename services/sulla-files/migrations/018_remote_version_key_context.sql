-- Exact random-key context attached to immutable remote versions. The server
-- stores identifiers only; collection keys and recovery envelopes remain in
-- the authoritative Vault service.
CREATE TABLE file_version_key_contexts (
  version_id UUID PRIMARY KEY REFERENCES file_versions(id) ON DELETE CASCADE,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL CHECK(principal_id <> ''),
  key_version INTEGER NOT NULL CHECK(key_version > 0),
  key_epoch INTEGER NOT NULL CHECK(key_epoch > 0)
);

-- Native watched-path publication is intentionally journaled outside the
-- metadata transaction. This lets startup distinguish a rolled-back process
-- from a committed transaction even when the COMMIT acknowledgement was lost.
CREATE TABLE files_path_operations (
  operation_id UUID PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN('move','copy')),
  state TEXT NOT NULL CHECK(state IN('planned','publishing','db-committed','completed','error')),
  plan JSONB NOT NULL,
  receipts JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX files_path_operations_pending
  ON files_path_operations(created_at)
  WHERE state NOT IN('completed','error');
