-- Optional on purpose: rolling back to the stock postgres image keeps keyword
-- search and the bounded JSON cosine fallback operational.
DO $migration$
DECLARE copied integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='vector') THEN
    RAISE NOTICE 'pgvector unavailable; leaving semantic search on JSON fallback';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS vector;
  EXECUTE 'CREATE TABLE IF NOT EXISTS file_search_vectors (
    chunk_id uuid PRIMARY KEY REFERENCES file_search_chunks(id) ON DELETE CASCADE,
    embedding halfvec(512) NOT NULL
  )';
  LOOP
    EXECUTE $sql$
      WITH batch AS (
        SELECT sc.id, sc.embedding_json::text AS embedding
        FROM file_search_chunks sc
        WHERE sc.embedding_json IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM file_search_vectors sv WHERE sv.chunk_id=sc.id)
        ORDER BY sc.id LIMIT 2000
      )
      INSERT INTO file_search_vectors(chunk_id,embedding)
      SELECT id,embedding::halfvec(512) FROM batch ON CONFLICT DO NOTHING
    $sql$;
    GET DIAGNOSTICS copied = ROW_COUNT;
    EXIT WHEN copied = 0;
  END LOOP;
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_file_search_vectors_hnsw ON file_search_vectors USING hnsw (embedding halfvec_cosine_ops) WITH (m=16,ef_construction=64)';
  LOOP
    EXECUTE $sql$
      WITH verified AS (
        SELECT sc.id FROM file_search_chunks sc JOIN file_search_vectors sv ON sv.chunk_id=sc.id
        WHERE sc.embedding_json IS NOT NULL ORDER BY sc.id LIMIT 5000
      )
      UPDATE file_search_chunks sc SET embedding_json=NULL FROM verified WHERE sc.id=verified.id
    $sql$;
    GET DIAGNOSTICS copied = ROW_COUNT;
    EXIT WHEN copied = 0;
  END LOOP;
  ALTER TABLE file_search_chunks SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_threshold=1000, autovacuum_analyze_threshold=1000);
END $migration$;
