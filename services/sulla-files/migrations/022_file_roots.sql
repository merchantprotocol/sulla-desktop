-- SPDX-License-Identifier: GPL-2.0-or-later
CREATE TABLE IF NOT EXISTS file_roots (
  id TEXT PRIMARY KEY CHECK(id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  collection_id UUID NOT NULL UNIQUE REFERENCES collections(id),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
  mount_path TEXT NOT NULL UNIQUE,
  sync_mode TEXT NOT NULL DEFAULT 'local' CHECK(sync_mode IN('local','server')),
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  exclusions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(exclusions)='array'),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN('idle','scanning','syncing','paused','offline','error','detached')),
  pending_files INTEGER NOT NULL DEFAULT 0 CHECK(pending_files >= 0),
  last_error TEXT,
  last_scan_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE watched_folder_state ADD COLUMN IF NOT EXISTS root_id TEXT;
UPDATE watched_folder_state SET root_id='default' WHERE root_id IS NULL;
ALTER TABLE watched_folder_state ALTER COLUMN root_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watched_folder_root ON watched_folder_state(root_id, path);

-- The default row is reconciled by LocalFilesManager after it resolves the
-- existing collection. No source path or file row is changed by this migration.
