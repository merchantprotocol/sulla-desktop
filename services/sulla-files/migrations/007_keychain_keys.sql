-- Separate envelopes keep remote-supplied collection metadata from replacing local keys.
CREATE TABLE files_key_state (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id), verifier JSONB NOT NULL);
CREATE TABLE files_collection_keys (
  collection_id UUID PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  key_origin TEXT NOT NULL DEFAULT 'random' CHECK (key_origin IN ('random','legacy-signing-v1')),
  data_key JSONB NOT NULL,
  dedup_key JSONB NOT NULL
);
-- Preserve deny markers across renames/restores; do not copy any file contents.
CREATE TABLE files_protected_files (file_id UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE);
INSERT INTO files_protected_files(file_id) SELECT id FROM files WHERE lower(path) ~ '(^|/)master[.]key($|/)';
CREATE TABLE files_protected_chunks (collection_id UUID NOT NULL, chunk_id TEXT NOT NULL, PRIMARY KEY(collection_id,chunk_id));
INSERT INTO files_protected_chunks(collection_id,chunk_id)
SELECT DISTINCT v.chunk_collection_id, jsonb_array_elements_text(m.chunk_ids)
FROM file_versions v JOIN files_protected_files p ON p.file_id=v.file_id JOIN manifests m ON m.hash=v.manifest_hash
ON CONFLICT DO NOTHING;
