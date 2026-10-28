-- SPDX-License-Identifier: GPL-2.0-or-later
-- Working project folders (Projects/<slug>/PROJECT.md, TASKS.md, ...) are shared and live as soon as
-- they are written, like Memory. Otherwise every agent task update would sit as an invisible draft.
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
      WHEN NEW.created_by_type='agent-run' OR target.require_approval OR EXISTS (SELECT 1 FROM collections c WHERE c.id=target.collection_id AND c.system_area='sulla' AND target.path LIKE 'Use Cases/%') THEN 'draft' ELSE 'published' END;
  END IF;
  IF NEW.deleted THEN NEW.publication_status:='superseded'; END IF;
  RETURN NEW;
END $$;
