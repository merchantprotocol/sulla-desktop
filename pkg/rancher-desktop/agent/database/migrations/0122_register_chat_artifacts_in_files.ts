/** Durable references from a sidebar artifact revision to its Files version. */
export const up = `
ALTER TABLE chat_artifacts
  ADD COLUMN IF NOT EXISTS files_file_id TEXT,
  ADD COLUMN IF NOT EXISTS files_version_id TEXT,
  ADD COLUMN IF NOT EXISTS files_collection_id TEXT,
  ADD COLUMN IF NOT EXISTS files_path TEXT,
  ADD COLUMN IF NOT EXISTS files_artifact_version INTEGER,
  ADD COLUMN IF NOT EXISTS files_registration_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS files_registration_error TEXT,
  ADD COLUMN IF NOT EXISTS files_registration_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS files_registration_updated_at TIMESTAMPTZ;

ALTER TABLE chat_artifacts DROP CONSTRAINT IF EXISTS chat_artifacts_files_registration_status_check;
ALTER TABLE chat_artifacts ADD CONSTRAINT chat_artifacts_files_registration_status_check
  CHECK (files_registration_status IN ('pending', 'synced', 'error'));

CREATE INDEX IF NOT EXISTS chat_artifacts_files_registration_pending
  ON chat_artifacts (files_registration_status, updated_at)
  WHERE is_deleted = false AND files_registration_status <> 'synced';
`;

export const down = `
DROP INDEX IF EXISTS chat_artifacts_files_registration_pending;
ALTER TABLE chat_artifacts DROP CONSTRAINT IF EXISTS chat_artifacts_files_registration_status_check;
ALTER TABLE chat_artifacts
  DROP COLUMN IF EXISTS files_registration_updated_at,
  DROP COLUMN IF EXISTS files_registration_attempts,
  DROP COLUMN IF EXISTS files_registration_error,
  DROP COLUMN IF EXISTS files_registration_status,
  DROP COLUMN IF EXISTS files_artifact_version,
  DROP COLUMN IF EXISTS files_path,
  DROP COLUMN IF EXISTS files_collection_id,
  DROP COLUMN IF EXISTS files_version_id,
  DROP COLUMN IF EXISTS files_file_id;
`;
