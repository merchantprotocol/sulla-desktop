ALTER TABLE collections ADD COLUMN IF NOT EXISTS keep_on_computer BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS files_chunk_cache (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL CHECK(chunk_id ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'resident' CHECK(state IN('resident','evicting','evicted')),
  stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK(stored_bytes >= 0),
  last_read_at TIMESTAMPTZ,
  evicted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(collection_id,chunk_id)
);
CREATE INDEX IF NOT EXISTS files_chunk_cache_lru_idx ON files_chunk_cache(last_read_at) WHERE state='resident';

INSERT INTO files_chunk_cache(collection_id,chunk_id,state,stored_bytes)
SELECT collection_id,id,'resident',stored_size FROM chunks
ON CONFLICT(collection_id,chunk_id) DO NOTHING;
