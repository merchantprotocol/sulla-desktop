ALTER TABLE journal DROP CONSTRAINT IF EXISTS journal_op_check;
ALTER TABLE journal ADD CONSTRAINT journal_op_check CHECK(op IN('put','restore','delete','promote','conflict','rename'));
CREATE TABLE IF NOT EXISTS watched_folder_state (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  size BIGINT NOT NULL,
  mtime_ms BIGINT NOT NULL,
  PRIMARY KEY(collection_id,path)
);
CREATE INDEX IF NOT EXISTS idx_watched_folder_hash ON watched_folder_state(collection_id,content_hash);
CREATE TABLE IF NOT EXISTS files_runtime_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id),
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL DEFAULT 'synced',
  pending_files INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_scan_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO files_runtime_state(id) VALUES(TRUE) ON CONFLICT DO NOTHING;
