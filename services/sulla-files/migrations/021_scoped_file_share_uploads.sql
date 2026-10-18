ALTER TABLE file_share_chunk_uploads
  ADD COLUMN target_collection_id UUID,
  ADD COLUMN file_path TEXT,
  ADD COLUMN actor_scope TEXT,
  ADD COLUMN plain_size INTEGER,
  ADD COLUMN uploaded_at TIMESTAMPTZ;

-- Rows created by migration 020 predate actor binding and authenticated chunk
-- geometry. Preserve them for auditability, but expire them and assign a scope
-- the service never produces so they cannot authorize an upload.
UPDATE file_share_chunk_uploads AS upload
SET target_collection_id = file.collection_id,
    file_path = file.path,
    actor_scope = 'legacy-invalid',
    plain_size = 0,
    expires_at = LEAST(upload.expires_at, NOW())
FROM files AS file
WHERE file.id = upload.file_id;

ALTER TABLE file_share_chunk_uploads
  ALTER COLUMN target_collection_id SET NOT NULL,
  ALTER COLUMN file_path SET NOT NULL,
  ALTER COLUMN actor_scope SET NOT NULL,
  ALTER COLUMN plain_size SET NOT NULL,
  DROP CONSTRAINT file_share_chunk_uploads_file_id_fkey,
  DROP CONSTRAINT file_share_chunk_uploads_pkey,
  ADD CONSTRAINT file_share_chunk_uploads_target_collection_id_fkey
    FOREIGN KEY(target_collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  ADD CONSTRAINT file_share_chunk_uploads_plain_size_check CHECK(plain_size >= 0),
  ADD CONSTRAINT file_share_chunk_uploads_pkey
    PRIMARY KEY(version_id,chunk_id,principal_id,actor_scope);

CREATE INDEX idx_file_share_chunk_uploads_scoped_lookup
  ON file_share_chunk_uploads(chunk_collection_id,chunk_id,principal_id,actor_scope,expires_at);
