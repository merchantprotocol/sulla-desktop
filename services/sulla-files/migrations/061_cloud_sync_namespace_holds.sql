-- SPDX-License-Identifier: GPL-2.0-or-later
-- A file or folder version whose parent folder Cloud cannot resolve is held here
-- instead of being published with an unknown (or silently root) parent. The push
-- cursor may move past a held version; it stays eligible and is retried after
-- retry_at. Additive bookkeeping only: no local file, folder or version row changes.
CREATE TABLE IF NOT EXISTS files_cloud_namespace_holds (
  version_id UUID PRIMARY KEY,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('file','folder')),
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts > 0),
  retry_at TIMESTAMPTZ NOT NULL,
  held_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS files_cloud_namespace_holds_collection ON files_cloud_namespace_holds(collection_id, retry_at);
