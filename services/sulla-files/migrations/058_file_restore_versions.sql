-- SPDX-License-Identifier: GPL-2.0-or-later
-- A restore is a new immutable version. Keep the source identity authenticated
-- separately from the tombstone it succeeds.
ALTER TABLE file_versions ADD COLUMN restored_from_version_id UUID REFERENCES file_versions(id);

CREATE TABLE files_cloud_namespace_batches (
  batch_id UUID PRIMARY KEY,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  root_item_id UUID NOT NULL,
  device_id TEXT NOT NULL,
  next_index INTEGER NOT NULL DEFAULT 0 CHECK(next_index>=0),
  sessions JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(collection_id,root_item_id)
);
