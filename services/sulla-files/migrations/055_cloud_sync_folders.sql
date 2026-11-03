-- SPDX-License-Identifier: GPL-2.0-or-later
-- Stable encrypted folder-object identities received through Files sync.
CREATE TABLE IF NOT EXISTS files_cloud_folders (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  file_id UUID NOT NULL,
  version_id UUID NOT NULL,
  path TEXT,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(collection_id,file_id),
  UNIQUE(collection_id,version_id)
);
