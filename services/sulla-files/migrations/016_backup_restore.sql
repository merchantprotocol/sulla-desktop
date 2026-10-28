-- SPDX-License-Identifier: GPL-2.0-or-later
CREATE TABLE files_restore_publications (
  snapshot_id TEXT PRIMARY KEY,
  archive_sha256 CHAR(64) NOT NULL CHECK(archive_sha256 ~ '^[a-f0-9]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
