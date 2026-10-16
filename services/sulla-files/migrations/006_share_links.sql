CREATE TABLE IF NOT EXISTS file_share_links (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('file', 'folder')),
  file_id UUID REFERENCES files(id),
  collection_id UUID REFERENCES collections(id),
  folder_path TEXT,
  display_name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  access_mode TEXT NOT NULL CHECK (access_mode IN ('view', 'download')),
  password_protected BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  view_count BIGINT NOT NULL DEFAULT 0,
  keep_available BOOLEAN NOT NULL DEFAULT FALSE,
  served_from TEXT NOT NULL CHECK (served_from IN ('desktop', 'server', 'cloud')),
  device_id TEXT,
  relay_secret TEXT,
  asset_kind TEXT NOT NULL DEFAULT 'file' CHECK (asset_kind IN ('file', 'capture', 'artifact')),
  capture_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  public_url TEXT,
  cloud_registered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((target_type='file' AND file_id IS NOT NULL AND collection_id IS NULL AND folder_path IS NULL)
    OR (target_type='folder' AND file_id IS NULL AND collection_id IS NOT NULL AND folder_path IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_file_share_links_owner_created ON file_share_links(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_share_links_active ON file_share_links(id) WHERE revoked_at IS NULL;
