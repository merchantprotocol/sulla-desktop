CREATE TABLE IF NOT EXISTS file_upload_intents (
  id UUID PRIMARY KEY,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(chunk_ids) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleanup_started_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_file_upload_intents_stale ON file_upload_intents(updated_at);
