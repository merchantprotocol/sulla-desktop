-- Durable per-file residency state. Remote proof rows are intentionally tied
-- to an immutable version and exact collection-key context.
CREATE TABLE files_remote_key_recovery (
  collection_id UUID PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK(key_version > 0),
  key_epoch INTEGER NOT NULL CHECK(key_epoch > 0),
  authority_key_id TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  UNIQUE(collection_id, principal_id, key_version, key_epoch)
);

CREATE TABLE file_remote_version_proofs (
  version_id UUID PRIMARY KEY REFERENCES file_versions(id) ON DELETE CASCADE,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  manifest_hash TEXT NOT NULL REFERENCES manifests(hash),
  remote_revision TEXT NOT NULL,
  chunks_digest TEXT NOT NULL CHECK(chunks_digest ~ '^[a-f0-9]{64}$'),
  key_version INTEGER NOT NULL CHECK(key_version > 0),
  key_epoch INTEGER NOT NULL CHECK(key_epoch > 0),
  verified_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE file_remote_chunk_proofs (
  version_id UUID NOT NULL REFERENCES file_remote_version_proofs(version_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  chunk_id TEXT NOT NULL CHECK(chunk_id ~ '^[a-f0-9]{64}$'),
  size INTEGER NOT NULL CHECK(size >= 0),
  stored_size INTEGER NOT NULL CHECK(stored_size >= 0),
  ciphertext_sha256 TEXT NOT NULL CHECK(ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(version_id, ordinal)
);

CREATE TABLE file_residency (
  file_id UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  desired_state TEXT NOT NULL DEFAULT 'local' CHECK(desired_state IN('local','online-only')),
  state TEXT NOT NULL DEFAULT 'local' CHECK(state IN('local','evicting','online-only','hydrating','error')),
  version_id UUID REFERENCES file_versions(id),
  operation_id UUID,
  generation BIGINT NOT NULL DEFAULT 0 CHECK(generation >= 0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX file_residency_pending ON file_residency(state) WHERE state IN('evicting','hydrating','error');
