CREATE TABLE IF NOT EXISTS folder_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL CHECK(folder_path <> '' AND folder_path !~ '(^|/)\.\.(/|$)'),
  principal_type TEXT NOT NULL CHECK(principal_type IN('user','group')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('view','edit')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(collection_id,folder_path,principal_type,principal_id)
);
CREATE INDEX IF NOT EXISTS idx_folder_shares_principal ON folder_shares(principal_type,principal_id,collection_id);
CREATE INDEX IF NOT EXISTS idx_folder_shares_collection_path ON folder_shares(collection_id,folder_path);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS org_id TEXT;
CREATE INDEX IF NOT EXISTS idx_files_trash ON files(collection_id,deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS generated_previews (
  version_id UUID NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('thumbnail')),
  mime TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(version_id,kind)
);
