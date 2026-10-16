-- Phase 6 search index.  The JSON embedding is the portable fallback used by
-- installations without pgvector; shipped Desktop and Server Postgres images
-- install the native vector extension and HNSW index below.
ALTER TABLE files ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ;
ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE files ADD COLUMN IF NOT EXISTS person_id TEXT;
CREATE INDEX IF NOT EXISTS idx_files_search_type ON files(collection_id,mime,updated_at);
CREATE INDEX IF NOT EXISTS idx_files_search_person ON files(collection_id,person_id);

CREATE TABLE IF NOT EXISTS file_search_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  embedding_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(version_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_file_search_chunks_fts ON file_search_chunks USING GIN(search_vector);

CREATE TABLE IF NOT EXISTS file_index_jobs (
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_id UUID PRIMARY KEY REFERENCES file_versions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN('pending','indexing','indexed','failed','unsupported')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_file_index_jobs_pending ON file_index_jobs(available_at,created_at) WHERE status='pending';

-- Every writer (watched-folder sync, server upload, restore, remote sync) updates
-- files.current_version_id. Keep indexing correctness centralized here so a new
-- API cannot accidentally leave stale searchable chunks behind.
CREATE OR REPLACE FUNCTION queue_file_search_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.search_text := NULL; NEW.extracted_at := NULL;
    NEW.extraction_status := CASE WHEN NEW.deleted_at IS NULL THEN 'pending' ELSE 'unsupported' END;
    DELETE FROM file_search_chunks WHERE file_id=NEW.id;
    DELETE FROM file_index_jobs WHERE file_id=NEW.id;
    IF NEW.deleted_at IS NULL AND NEW.current_version_id IS NOT NULL THEN
      INSERT INTO file_index_jobs(file_id,version_id,status) VALUES(NEW.id,NEW.current_version_id,'pending');
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_queue_file_search_index ON files;
CREATE TRIGGER trg_queue_file_search_index BEFORE UPDATE OF current_version_id,deleted_at ON files FOR EACH ROW EXECUTE FUNCTION queue_file_search_index();

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  EXECUTE 'CREATE TABLE IF NOT EXISTS file_search_vectors (
    chunk_id UUID PRIMARY KEY REFERENCES file_search_chunks(id) ON DELETE CASCADE,
    embedding vector(512) NOT NULL
  )';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_file_search_vectors_hnsw ON file_search_vectors USING hnsw (embedding vector_cosine_ops)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector unavailable; using portable file_search_chunks.embedding_json fallback';
END $$;
