-- SPDX-License-Identifier: GPL-2.0-or-later
-- Empty folders are first-class Files metadata. They are not materialized in a
-- watched host root, so they survive restarts in stored-only Desktop and server
-- collections without inventing placeholder files.
CREATE TABLE IF NOT EXISTS file_folders (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK(path <> '' AND path !~ '(^/|/$|//)'),
  created_by_type TEXT NOT NULL DEFAULT 'user',
  created_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(collection_id, path)
);

CREATE INDEX IF NOT EXISTS file_folders_collection_path ON file_folders(collection_id, path);
