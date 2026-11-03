-- SPDX-License-Identifier: GPL-2.0-or-later
-- Give every stored folder a stable namespace identity/version chain and put
-- folder-only mutations on the same monotonic cursor as file journal entries.
ALTER TABLE file_folders
  ADD COLUMN namespace_version_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN namespace_parent_version_id UUID;

CREATE TABLE files_folder_journal (
  seq BIGINT PRIMARY KEY DEFAULT nextval(pg_get_serial_sequence('journal','seq')),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  folder_id UUID NOT NULL,
  version_id UUID NOT NULL,
  parent_version_id UUID,
  restored_from_version_id UUID,
  path TEXT NOT NULL,
  deleted BOOLEAN NOT NULL,
  op TEXT NOT NULL CHECK(op IN('create','metadata','delete','restore')),
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(version_id)
);
CREATE INDEX files_folder_journal_collection_seq ON files_folder_journal(collection_id,seq);
CREATE TABLE files_cloud_folder_versions (
  version_id UUID PRIMARY KEY,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  folder_id UUID NOT NULL,
  pushed_seq BIGINT CHECK(pushed_seq >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION files_journal_folder_namespace() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE suppressed BOOLEAN := COALESCE(current_setting('sulla_files.cloud_pull',TRUE),'')='on';
BEGIN
  IF suppressed THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (NEW.collection_id,NEW.path,NEW.deleted_at) IS NOT DISTINCT FROM (OLD.collection_id,OLD.path,OLD.deleted_at) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    NEW.namespace_parent_version_id := OLD.namespace_version_id;
    NEW.namespace_version_id := gen_random_uuid();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER folders_journal_namespace_before BEFORE INSERT OR UPDATE ON file_folders
  FOR EACH ROW EXECUTE FUNCTION files_journal_folder_namespace();

CREATE FUNCTION files_append_folder_namespace_journal() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE suppressed BOOLEAN := COALESCE(current_setting('sulla_files.cloud_pull',TRUE),'')='on';
BEGIN
  IF suppressed THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (NEW.collection_id,NEW.path,NEW.deleted_at) IS NOT DISTINCT FROM (OLD.collection_id,OLD.path,OLD.deleted_at) THEN RETURN NEW; END IF;
  INSERT INTO files_folder_journal(collection_id,folder_id,version_id,parent_version_id,restored_from_version_id,path,deleted,op)
  VALUES(NEW.collection_id,NEW.id,NEW.namespace_version_id,NEW.namespace_parent_version_id,CASE WHEN TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN OLD.namespace_parent_version_id ELSE NULL END,NEW.path,NEW.deleted_at IS NOT NULL,
    CASE WHEN TG_OP='INSERT' THEN 'create' WHEN NEW.deleted_at IS NOT NULL THEN 'delete'
         WHEN OLD.deleted_at IS NOT NULL THEN 'restore' ELSE 'metadata' END);
  RETURN NEW;
END $$;
CREATE TRIGGER folders_append_namespace_after AFTER INSERT OR UPDATE ON file_folders
  FOR EACH ROW EXECUTE FUNCTION files_append_folder_namespace_journal();
