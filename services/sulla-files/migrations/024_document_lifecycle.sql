-- SPDX-License-Identifier: GPL-2.0-or-later
ALTER TABLE files
  ADD COLUMN IF NOT EXISTS draft_version_id UUID,
  ADD COLUMN IF NOT EXISTS published_version_id UUID,
  ADD COLUMN IF NOT EXISTS versioning_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS major_minor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS require_approval BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS require_checkout BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS checked_out_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS checked_out_by_device_id TEXT,
  ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retention_mode TEXT NOT NULL DEFAULT 'none' CHECK(retention_mode IN('none','retain-until','event')),
  ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retention_event_type TEXT,
  ADD COLUMN IF NOT EXISTS retention_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retention_duration_days INTEGER CHECK(retention_duration_days IS NULL OR retention_duration_days >= 0),
  ADD COLUMN IF NOT EXISTS record_lock_type TEXT NOT NULL DEFAULT 'none' CHECK(record_lock_type IN('none','ordinary','policy')),
  ADD COLUMN IF NOT EXISTS record_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS record_locked_by TEXT,
  ADD COLUMN IF NOT EXISTS disposal_status TEXT NOT NULL DEFAULT 'none' CHECK(disposal_status IN('none','pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS disposal_review_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disposal_extended_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_generation BIGINT NOT NULL DEFAULT 0;

ALTER TABLE file_versions
  ADD COLUMN IF NOT EXISTS major_version INTEGER CHECK(major_version IS NULL OR major_version >= 0),
  ADD COLUMN IF NOT EXISTS minor_version INTEGER CHECK(minor_version IS NULL OR minor_version >= 0),
  ADD COLUMN IF NOT EXISTS version_kind TEXT CHECK(version_kind IN('major','minor')),
  ADD COLUMN IF NOT EXISTS publication_status TEXT CHECK(publication_status IN('draft','published','superseded')),
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by TEXT,
  ADD COLUMN IF NOT EXISTS version_comment TEXT;

UPDATE file_versions v SET major_version=1,minor_version=0,version_kind='major',publication_status='published',published_at=v.created_at
  FROM files f WHERE f.current_version_id=v.id AND v.deleted=FALSE AND v.major_version IS NULL;
WITH numbered AS (
  SELECT id,row_number() OVER(PARTITION BY file_id ORDER BY created_at,id)::int AS revision
  FROM file_versions WHERE major_version IS NULL
) UPDATE file_versions v SET major_version=0,minor_version=numbered.revision,version_kind='minor',publication_status='superseded'
  FROM numbered WHERE v.id=numbered.id;
UPDATE files SET published_version_id=current_version_id
  WHERE published_version_id IS NULL AND current_version_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM file_versions v WHERE v.id=files.current_version_id AND v.deleted=FALSE);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_versions_number
  ON file_versions(file_id,major_version,minor_version)
  WHERE major_version IS NOT NULL AND minor_version IS NOT NULL;

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_draft_version_id_fkey;
ALTER TABLE files ADD CONSTRAINT files_draft_version_id_fkey FOREIGN KEY(draft_version_id) REFERENCES file_versions(id);
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_published_version_id_fkey;
ALTER TABLE files ADD CONSTRAINT files_published_version_id_fkey FOREIGN KEY(published_version_id) REFERENCES file_versions(id);

CREATE OR REPLACE FUNCTION files_retention_active(target files, at_time TIMESTAMPTZ DEFAULT NOW()) RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  SELECT target.record_lock_type <> 'none'
    OR (target.retention_mode='retain-until' AND target.retain_until IS NOT NULL AND target.retain_until > at_time)
    OR (target.retention_mode='event' AND (target.retention_event_at IS NULL OR target.retention_duration_days IS NULL
      OR target.retention_event_at + make_interval(days => target.retention_duration_days) > at_time))
    OR (target.disposal_extended_until IS NOT NULL AND target.disposal_extended_until > at_time)
$$;

CREATE OR REPLACE FUNCTION files_prepare_version_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target files%ROWTYPE; latest_major INTEGER; latest_minor INTEGER;
BEGIN
  SELECT * INTO target FROM files WHERE id=NEW.file_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF current_setting('sulla.trusted_replication',TRUE)='on' THEN RETURN NEW; END IF;
  IF target.record_lock_type <> 'none' THEN RAISE EXCEPTION 'record is locked' USING ERRCODE='55000'; END IF;
  IF target.require_checkout AND (target.checked_out_by_user_id IS DISTINCT FROM NEW.created_by_id
    OR (target.checked_out_by_device_id IS NOT NULL AND target.checked_out_by_device_id IS DISTINCT FROM NEW.device_id)) THEN
    RAISE EXCEPTION 'file must be checked out by this editor' USING ERRCODE='55000';
  END IF;
  SELECT COALESCE(MAX(major_version),0),COALESCE(MAX(minor_version) FILTER(WHERE major_version=(SELECT COALESCE(MAX(major_version),0) FROM file_versions WHERE file_id=NEW.file_id)),0)
    INTO latest_major,latest_minor FROM file_versions WHERE file_id=NEW.file_id;
  IF NEW.version_kind IS NULL THEN NEW.version_kind := CASE WHEN target.major_minor_enabled THEN 'minor' ELSE 'major' END; END IF;
  IF NEW.version_kind='major' THEN NEW.major_version:=latest_major+1; NEW.minor_version:=0;
  ELSE NEW.major_version:=latest_major; NEW.minor_version:=latest_minor+1; END IF;
  IF NEW.publication_status IS NULL THEN NEW.publication_status:=CASE WHEN target.require_approval AND NOT NEW.deleted THEN 'draft' ELSE 'published' END; END IF;
  IF NEW.deleted THEN NEW.publication_status:='superseded'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS file_versions_prepare_lifecycle ON file_versions;
CREATE TRIGGER file_versions_prepare_lifecycle BEFORE INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION files_prepare_version_lifecycle();

CREATE OR REPLACE FUNCTION files_guard_version_lifecycle_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target files%ROWTYPE;
BEGIN
  IF current_setting('sulla.trusted_replication',TRUE)='on' THEN RETURN NEW; END IF;
  IF (NEW.publication_status,NEW.version_kind,NEW.major_version,NEW.minor_version,NEW.published_at,NEW.published_by)
      IS DISTINCT FROM
     (OLD.publication_status,OLD.version_kind,OLD.major_version,OLD.minor_version,OLD.published_at,OLD.published_by) THEN
    SELECT * INTO target FROM files WHERE id=OLD.file_id FOR UPDATE;
    IF FOUND AND target.record_lock_type <> 'none' THEN RAISE EXCEPTION 'record is locked' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS file_versions_guard_lifecycle_update ON file_versions;
CREATE TRIGGER file_versions_guard_lifecycle_update BEFORE UPDATE ON file_versions FOR EACH ROW EXECUTE FUNCTION files_guard_version_lifecycle_update();

CREATE OR REPLACE FUNCTION files_guard_destructive_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('sulla.trusted_replication',TRUE)='on' THEN RETURN NEW; END IF;
  IF OLD.record_lock_type <> 'none' AND
     (NEW.current_version_id,NEW.draft_version_id,NEW.published_version_id) IS DISTINCT FROM
     (OLD.current_version_id,OLD.draft_version_id,OLD.published_version_id) THEN
    RAISE EXCEPTION 'record is locked' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS files_guard_destructive_update ON files;
CREATE TRIGGER files_guard_destructive_update BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION files_guard_destructive_update();

CREATE OR REPLACE FUNCTION files_advance_version_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('sulla.trusted_replication',TRUE)='on' THEN RETURN NEW; END IF;
  IF NEW.deleted THEN RETURN NEW; END IF;
  IF NEW.publication_status='published' THEN
    UPDATE file_versions SET publication_status='superseded' WHERE file_id=NEW.file_id AND id<>NEW.id AND publication_status='published';
    UPDATE files SET published_version_id=NEW.id,draft_version_id=NULL,lifecycle_generation=lifecycle_generation+1 WHERE id=NEW.file_id;
  ELSE
    UPDATE files SET draft_version_id=NEW.id,lifecycle_generation=lifecycle_generation+1 WHERE id=NEW.file_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS file_versions_advance_lifecycle ON file_versions;
CREATE TRIGGER file_versions_advance_lifecycle AFTER INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION files_advance_version_lifecycle();

CREATE OR REPLACE FUNCTION files_protect_retained_file_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF files_retention_active(OLD) THEN RAISE EXCEPTION 'retained or locked Files records cannot be purged' USING ERRCODE='55000'; END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS files_protect_retained_file_delete ON files;
CREATE TRIGGER files_protect_retained_file_delete BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION files_protect_retained_file_delete();

CREATE OR REPLACE FUNCTION files_protect_retained_version_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target files%ROWTYPE;
BEGIN
  SELECT * INTO target FROM files WHERE id=OLD.file_id FOR UPDATE;
  IF FOUND AND files_retention_active(target) THEN RAISE EXCEPTION 'retained or locked Files records cannot be purged' USING ERRCODE='55000'; END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS files_protect_retained_version_delete ON file_versions;
CREATE TRIGGER files_protect_retained_version_delete BEFORE DELETE ON file_versions FOR EACH ROW EXECUTE FUNCTION files_protect_retained_version_delete();

ALTER TABLE journal DROP CONSTRAINT IF EXISTS journal_op_check;
ALTER TABLE journal ADD CONSTRAINT journal_op_check CHECK(op IN('put','restore','delete','promote','conflict','rename','lifecycle'));

CREATE TABLE IF NOT EXISTS file_purge_tombstones (
  seq BIGINT PRIMARY KEY DEFAULT nextval(pg_get_serial_sequence('journal','seq')),
  collection_id UUID NOT NULL REFERENCES collections(id),
  file_id UUID NOT NULL UNIQUE,
  path TEXT NOT NULL,
  lifecycle_generation BIGINT NOT NULL,
  audience JSONB NOT NULL DEFAULT '{"users":[],"groups":[]}'::jsonb,
  purged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_file_purge_tombstones_collection_seq ON file_purge_tombstones(collection_id,seq);

CREATE TABLE IF NOT EXISTS file_chunk_gc (
  collection_id UUID NOT NULL REFERENCES collections(id),
  chunk_id TEXT NOT NULL,
  audit_id BIGINT REFERENCES audit_log(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  PRIMARY KEY(collection_id,chunk_id)
);

-- Keep historical/published indexes when a newer draft becomes current. Access
-- checks select the visible version, so deleting the old chunks would make the
-- last published document disappear from search for read-only principals.
CREATE OR REPLACE FUNCTION queue_file_search_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.search_text := NULL; NEW.extracted_at := NULL;
    NEW.extraction_status := CASE WHEN NEW.deleted_at IS NULL THEN 'pending' ELSE 'unsupported' END;
    NEW.extraction_reason_code := CASE WHEN NEW.deleted_at IS NULL THEN 'queued' ELSE 'deleted' END;
    NEW.extraction_reason := CASE WHEN NEW.deleted_at IS NULL THEN 'Waiting for local indexing.' ELSE 'Deleted files are not indexed.' END;
    IF NEW.deleted_at IS NULL AND NEW.current_version_id IS NOT NULL THEN
      INSERT INTO file_index_jobs(file_id,version_id,status,reason_code,reason)
      VALUES(NEW.id,NEW.current_version_id,'pending','queued','Waiting for local indexing.')
      ON CONFLICT(version_id) DO UPDATE SET status='pending',attempts=0,last_error=NULL,available_at=NOW(),started_at=NULL,finished_at=NULL,reason_code='queued',reason='Waiting for local indexing.';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE INDEX IF NOT EXISTS idx_files_retention ON files(retain_until,record_lock_type,disposal_extended_until) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_versions_publication ON file_versions(file_id,publication_status,major_version DESC,minor_version DESC);
