-- Keyset pagination for GET /v1/local/native-sources (ORDER BY created_at, source_handle LIMIT n).
-- Without this every inventory call sorted the whole table on disk.
CREATE INDEX IF NOT EXISTS files_native_sources_created ON files_native_sources(created_at, source_handle);
