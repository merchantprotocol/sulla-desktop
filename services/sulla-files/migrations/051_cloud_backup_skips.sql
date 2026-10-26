-- Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
-- Licensed under the Sulla Fair-Code License. See LICENSE.
--
-- A file version that keeps failing Cloud backup is parked here so the rest of the
-- collection keeps backing up. It is retried after retry_at; a new version of the file
-- is a new row and is tried right away.
CREATE TABLE IF NOT EXISTS files_cloud_skips (
  version_id UUID PRIMARY KEY REFERENCES file_versions(id) ON DELETE CASCADE,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  file_id UUID NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts > 0),
  retry_at TIMESTAMPTZ NOT NULL,
  skipped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS files_cloud_skips_collection ON files_cloud_skips(collection_id, retry_at);
