-- SPDX-License-Identifier: GPL-2.0-or-later
-- Files cloud sync v1 (FILES-SYNC-DESIGN.md §5). Ciphertext-only backup to Sulla Cloud.
-- wrapped_root is the per-collection sync root R wrapped for local at-rest storage; it never leaves the VM.
CREATE TABLE IF NOT EXISTS files_cloud_sync (
  collection_id UUID PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version > 0),
  wrapped_root JSONB,
  last_seq BIGINT NOT NULL DEFAULT 0 CHECK(last_seq >= 0),
  head JSONB,
  status TEXT NOT NULL DEFAULT 'off' CHECK(status IN ('off','idle','syncing','error','needs-vault')),
  last_error TEXT,
  last_sync_at TIMESTAMPTZ,
  pending_bytes BIGINT NOT NULL DEFAULT 0 CHECK(pending_bytes >= 0),
  conflicts BIGINT NOT NULL DEFAULT 0 CHECK(conflicts >= 0),
  cloud_created BOOLEAN NOT NULL DEFAULT FALSE,
  escrow_vault_id UUID,
  escrow_vault_epoch BIGINT,
  upload_session JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Local chunk ↔ cloud chunk. P4 reads verified_at to decide what may be evicted.
CREATE TABLE IF NOT EXISTS files_cloud_chunk_map (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  local_chunk_id TEXT NOT NULL CHECK(local_chunk_id ~ '^[0-9a-f]{64}$'),
  cloud_chunk_id TEXT NOT NULL CHECK(cloud_chunk_id ~ '^[0-9a-f]{64}$'),
  cipher_sha256 TEXT NOT NULL CHECK(cipher_sha256 ~ '^[0-9a-f]{64}$'),
  cipher_bytes BIGINT NOT NULL CHECK(cipher_bytes > 0),
  uploaded_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  PRIMARY KEY(collection_id, local_chunk_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS files_cloud_chunk_map_cloud ON files_cloud_chunk_map(collection_id, cloud_chunk_id);

-- Local versions known to Cloud (pushed from here or applied from a pull) and the seq they landed at.
CREATE TABLE IF NOT EXISTS files_cloud_versions (
  version_id UUID PRIMARY KEY REFERENCES file_versions(id) ON DELETE CASCADE,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  file_id UUID NOT NULL,
  pushed_seq BIGINT CHECK(pushed_seq >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS files_cloud_versions_collection ON files_cloud_versions(collection_id, pushed_seq);

-- What this device last saw as each file's cloud head. Commit baseVersionId and both stateHash checks use it.
CREATE TABLE IF NOT EXISTS files_cloud_file_heads (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  file_id UUID NOT NULL,
  version_id UUID NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  seq BIGINT NOT NULL CHECK(seq >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(collection_id, file_id)
);

-- Device-signed Cloud calls waiting for main to sign. body is the exact JSON text whose sha256 is signed.
CREATE TABLE IF NOT EXISTS files_cloud_operations (
  handle UUID PRIMARY KEY,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  op TEXT NOT NULL CHECK(op IN ('create','escrow','upload-open','commit','delete')),
  path TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('PUT','POST','DELETE')),
  body TEXT,
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS files_cloud_operations_ready ON files_cloud_operations(created_at);
