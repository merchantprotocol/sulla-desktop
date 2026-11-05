-- SPDX-License-Identifier: GPL-2.0-or-later
-- Repair mount versions which bypassed the approval gate. A real approval
-- always records both published_at and published_by, so those rows are excluded.
WITH malformed AS (
  UPDATE file_versions
  SET publication_status='draft',version_kind='minor'
  WHERE created_by_type IN ('agent','agent-run')
    AND publication_status='published'
    AND published_at IS NULL
    AND published_by IS NULL
    AND EXISTS (SELECT 1 FROM files f WHERE f.id=file_versions.file_id AND f.path LIKE 'Use Cases/%')
  RETURNING id,file_id,created_at
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

-- Agent identity, rather than the path alone, is the approval boundary. Human
-- edits retain their existing immediate-publication behavior.
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
    NEW.publication_status:=CASE WHEN NOT target.require_approval AND EXISTS (SELECT 1 FROM collections c WHERE c.id=target.collection_id AND c.system_area='sulla' AND (target.path LIKE 'Memory/%' OR target.path LIKE 'Projects/%')) THEN 'published'
      WHEN NEW.created_by_type='agent-run' OR (NEW.created_by_type='agent' AND target.path LIKE 'Use Cases/%') OR target.require_approval THEN 'draft' ELSE 'published' END;
  END IF;
  IF NEW.deleted THEN NEW.publication_status:='superseded'; END IF;
  RETURN NEW;
END $$;
