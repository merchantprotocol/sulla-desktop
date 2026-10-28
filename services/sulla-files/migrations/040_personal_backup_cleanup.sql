-- SPDX-License-Identifier: GPL-2.0-or-later
ALTER TABLE files_backup_snapshots ADD COLUMN prune_manifest JSONB;

-- Durable, idempotent cleanup after a verified replacement. No object is deleted
-- until every retained manifest has been checked for references.
CREATE TABLE files_backup_gc_objects (
  destination_id UUID NOT NULL REFERENCES files_backup_destinations(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  PRIMARY KEY(destination_id, object_key)
);

CREATE INDEX files_backup_runs_destination_started
  ON files_backup_runs(destination_id, started_at DESC);
