-- Structure only. The copy of existing JSON embeddings, the HNSW build and the JSON
-- cleanup run as a throttled background job (src/vectorBackfill.ts) so a large corpus
-- never holds up service startup. Optional on purpose: on the stock postgres image
-- keyword search and the bounded JSON cosine fallback stay operational.
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='vector') THEN
    RAISE NOTICE 'pgvector unavailable; leaving semantic search on JSON fallback';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS vector;
  -- Migration 005 creates a float32 vector(512) table on databases that already had
  -- pgvector. Convert it in place so the halfvec index and queries line up.
  IF to_regclass('file_search_vectors') IS NOT NULL AND COALESCE((
    SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a
    WHERE a.attrelid=to_regclass('file_search_vectors') AND a.attname='embedding' AND NOT a.attisdropped
  ),'') <> 'halfvec(512)' THEN
    DROP INDEX IF EXISTS idx_file_search_vectors_hnsw;
    ALTER TABLE file_search_vectors ALTER COLUMN embedding TYPE halfvec(512) USING embedding::halfvec(512);
    DELETE FROM files_schema_migrations WHERE version='045_pgvector_backfill_complete';
  END IF;
  EXECUTE 'CREATE TABLE IF NOT EXISTS file_search_vectors (
    chunk_id uuid PRIMARY KEY REFERENCES file_search_chunks(id) ON DELETE CASCADE,
    embedding halfvec(512) NOT NULL
  )';
  ALTER TABLE file_search_chunks SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_threshold=1000, autovacuum_analyze_threshold=1000);
END $migration$;
