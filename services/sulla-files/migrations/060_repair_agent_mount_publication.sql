-- SPDX-License-Identifier: GPL-2.0-or-later
-- Repair mount versions which bypassed the Use Cases approval gate. A real
-- approval records both published_at and published_by, so those rows survive.
--
-- Undo/restore: before rollout, retain a database backup (or the file_versions
-- and files audit/history rows). To reverse, restore each repaired version's
-- prior publication_status/version_kind and each affected file's lifecycle
-- pointers/generation from that backup or audit history. The content rows are
-- never deleted, so this migration is logically reversible.
--
-- This migration first shipped with the fix branch and is not in a release tag,
-- so its definition remains editable rather than being superseded by 061.
CREATE OR REPLACE FUNCTION files_is_use_case_path(system_area TEXT, candidate_path TEXT)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(system_area, '') <> 'logs' AND candidate_path LIKE 'Use Cases/%'
$$;

-- Supports the one-time repair without scanning every historical version.
CREATE INDEX IF NOT EXISTS file_versions_malformed_agent_publication_idx
ON file_versions(file_id, created_at DESC, id DESC)
WHERE created_by_type IN ('agent','agent-run')
  AND publication_status='published'
  AND published_at IS NULL
  AND published_by IS NULL;

WITH malformed AS (
  UPDATE file_versions v
  SET publication_status='draft',version_kind='minor'
  FROM files f JOIN collections c ON c.id=f.collection_id
  WHERE f.id=v.file_id
    AND v.created_by_type IN ('agent','agent-run')
    AND v.publication_status='published'
    AND v.published_at IS NULL
    AND v.published_by IS NULL
    AND files_is_use_case_path(c.system_area,f.path)
  RETURNING v.id,v.file_id,v.created_at
), affected AS (
  SELECT DISTINCT file_id FROM malformed
)
UPDATE files f
SET draft_version_id=(
      SELECT m.id FROM malformed m WHERE m.file_id=f.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1
    ),
    published_version_id=(
      SELECT v.id FROM file_versions v
      WHERE v.file_id=f.id AND v.published_at IS NOT NULL AND v.published_by IS NOT NULL
        AND v.publication_status IN ('published','superseded')
      ORDER BY v.published_at DESC,v.created_at DESC,v.id DESC LIMIT 1
    ),
    lifecycle_generation=f.lifecycle_generation+1,
    updated_at=NOW()
WHERE f.id IN (SELECT file_id FROM affected);

CREATE OR REPLACE FUNCTION files_prepare_version_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target files%ROWTYPE; target_system_area TEXT; latest_major INTEGER; latest_minor INTEGER;
BEGIN
  SELECT * INTO target FROM files WHERE id=NEW.file_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT system_area INTO target_system_area FROM collections WHERE id=target.collection_id;
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
    NEW.publication_status:=CASE
      WHEN target.require_approval THEN 'draft'
      WHEN NEW.created_by_type IN ('agent','agent-run') AND files_is_use_case_path(target_system_area,target.path) THEN 'draft'
      ELSE 'published' END;
  END IF;
  IF NEW.deleted THEN NEW.publication_status:='superseded'; END IF;
  RETURN NEW;
END $$;
