CREATE TABLE IF NOT EXISTS files_publish_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','expired')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_files_publish_requests_status_created
  ON files_publish_requests(status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_publish_requests_pending_version
  ON files_publish_requests(file_id,version_id) WHERE status='pending';

-- Agent-produced versions always remain drafts until a human publishes them.
CREATE OR REPLACE FUNCTION files_prepare_version_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target files%ROWTYPE; latest_major INTEGER; latest_minor INTEGER;
BEGIN
  SELECT * INTO target FROM files WHERE id=NEW.file_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF current_setting('sulla.trusted_replication',TRUE)='on' THEN RETURN NEW; END IF;
  IF files_retention_active(target) THEN RAISE EXCEPTION 'file is locked by record retention' USING ERRCODE='55000'; END IF;
  IF target.require_checkout AND (target.checked_out_by_user_id IS DISTINCT FROM NEW.created_by_id
    OR (target.checked_out_by_device_id IS NOT NULL AND target.checked_out_by_device_id IS DISTINCT FROM NEW.device_id)) THEN
    RAISE EXCEPTION 'file must be checked out by this editor' USING ERRCODE='55000';
  END IF;
  SELECT COALESCE(MAX(major_version),0),COALESCE(MAX(minor_version) FILTER(WHERE major_version=(SELECT COALESCE(MAX(major_version),0) FROM file_versions WHERE file_id=NEW.file_id)),0)
    INTO latest_major,latest_minor FROM file_versions WHERE file_id=NEW.file_id;
  IF NEW.version_kind IS NULL THEN NEW.version_kind := CASE WHEN target.major_minor_enabled THEN 'minor' ELSE 'major' END; END IF;
  IF NEW.version_kind='major' THEN NEW.major_version:=latest_major+1; NEW.minor_version:=0;
  ELSE NEW.major_version:=latest_major; NEW.minor_version:=latest_minor+1; END IF;
  IF NEW.publication_status IS NULL THEN
    NEW.publication_status:=CASE WHEN NEW.created_by_type='agent-run' OR target.require_approval THEN 'draft' ELSE 'published' END;
  END IF;
  IF NEW.deleted THEN NEW.publication_status:='superseded'; END IF;
  RETURN NEW;
END $$;

-- Retention and record locks protect every content/path/destructive mutation.
CREATE OR REPLACE FUNCTION files_guard_destructive_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('sulla.trusted_replication',TRUE)='on' THEN RETURN NEW; END IF;
  IF files_retention_active(OLD) AND
     (NEW.path,NEW.current_version_id,NEW.draft_version_id,NEW.published_version_id,NEW.deleted_at,NEW.mime,NEW.size)
       IS DISTINCT FROM
     (OLD.path,OLD.current_version_id,OLD.draft_version_id,OLD.published_version_id,OLD.deleted_at,OLD.mime,OLD.size) THEN
    RAISE EXCEPTION 'file is locked by record retention' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
