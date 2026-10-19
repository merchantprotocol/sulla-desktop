-- Same schema as 026_stored_folders on the native integration branch.
CREATE TABLE IF NOT EXISTS file_folders (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK(path <> '' AND path !~ '(^/|/$|//)'),
  created_by_type TEXT NOT NULL DEFAULT 'user', created_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(collection_id,path)
);
CREATE INDEX IF NOT EXISTS file_folders_collection_path ON file_folders(collection_id,path);
ALTER TABLE file_folders ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid(), ADD COLUMN operation_revision BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX file_folders_identity ON file_folders(id);
CREATE TRIGGER folders_advance_operation_revision BEFORE UPDATE ON file_folders
  FOR EACH ROW EXECUTE FUNCTION files_advance_operation_revision();
ALTER TABLE files_database_operation_receipts DROP CONSTRAINT files_database_operation_receipts_action_check;
ALTER TABLE files_database_operation_receipts ADD CONSTRAINT files_database_operation_receipts_action_check CHECK(action IN('move','copy','rename','trash','create-folder'));
ALTER TABLE files_database_operation_receipts ADD COLUMN displaced_before JSONB, ADD COLUMN displaced_after JSONB;
ALTER TABLE files_database_operation_receipts ADD COLUMN permission_signature TEXT;
ALTER TABLE files_database_operation_receipts ALTER COLUMN file_id DROP NOT NULL;
CREATE TABLE files_database_operation_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id TEXT NOT NULL, actor_scope TEXT NOT NULL, idempotency_key UUID NOT NULL,
  collection_id UUID NOT NULL, request JSONB NOT NULL,
  item_keys JSONB NOT NULL,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE, errors JSONB NOT NULL DEFAULT '{}'::jsonb, overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(actor_user_id,actor_scope,idempotency_key)
);

-- Indexing-only updates do not invalidate an otherwise exact inverse. All
-- semantic fields (including lifecycle, publication, path and expiry) do.
CREATE OR REPLACE FUNCTION files_advance_operation_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_revision IS DISTINCT FROM OLD.operation_revision OR (to_jsonb(NEW) - ARRAY['operation_revision','search_text','search_vector','extracted_at','extraction_status','extraction_reason_code','extraction_reason','updated_at'])
    IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['operation_revision','search_text','search_vector','extracted_at','extraction_status','extraction_reason_code','extraction_reason','updated_at']) THEN
    NEW.operation_revision := OLD.operation_revision + 1;
  ELSE NEW.operation_revision := OLD.operation_revision;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION files_invalidate_version_receipt() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.publication_status,NEW.version_kind,NEW.major_version,NEW.minor_version,NEW.published_at,NEW.published_by,NEW.manifest_hash,NEW.size,NEW.deleted)
    IS DISTINCT FROM (OLD.publication_status,OLD.version_kind,OLD.major_version,OLD.minor_version,OLD.published_at,OLD.published_by,OLD.manifest_hash,OLD.size,OLD.deleted) THEN
    UPDATE files SET operation_revision=operation_revision+1 WHERE id=NEW.file_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_versions_invalidate_receipt AFTER UPDATE ON file_versions
  FOR EACH ROW EXECUTE FUNCTION files_invalidate_version_receipt();

-- Every writer, including legacy routes, participates in the collection
-- namespace protocol. No global files table lock spans content/network work.
CREATE FUNCTION files_guard_operation_namespace() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE cid UUID; p TEXT; own UUID;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.collection_id,NEW.path) IS NOT DISTINCT FROM (OLD.collection_id,OLD.path) THEN RETURN NEW; END IF;
  cid:=NEW.collection_id; p:=NEW.path;
  PERFORM pg_advisory_xact_lock(hashtextextended('stored-namespace:'||cid,0));
  IF TG_TABLE_NAME='files' THEN
    own:=NEW.id;
    IF EXISTS(SELECT 1 FROM file_folders WHERE collection_id=cid AND (path=p OR starts_with(path,p||'/'))) THEN
      RAISE EXCEPTION 'Folder occupies file destination' USING ERRCODE='23505';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM files WHERE collection_id=cid AND (own IS NULL OR id<>own)
    AND (path=p OR starts_with(p,path||'/') OR (TG_TABLE_NAME='files' AND starts_with(path,p||'/')))) THEN
    RAISE EXCEPTION 'File occupies namespace destination' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER files_guard_operation_namespace BEFORE INSERT OR UPDATE OF path,collection_id ON files
  FOR EACH ROW EXECUTE FUNCTION files_guard_operation_namespace();
CREATE TRIGGER folders_guard_operation_namespace BEFORE INSERT OR UPDATE OF path,collection_id ON file_folders
  FOR EACH ROW EXECUTE FUNCTION files_guard_operation_namespace();
