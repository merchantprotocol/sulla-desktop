-- Run by the transactional migration runner. Block old writers during cutover;
-- fail quickly rather than waiting indefinitely behind a long transaction.
SET LOCAL lock_timeout = '10s';
LOCK TABLE files IN ACCESS EXCLUSIVE MODE;

-- Keep extracted text and its GIN index out of the hot files metadata row.
-- The copy is deliberately bounded so PostgreSQL never has to materialize all
-- extracted text at once on established Desktop databases.
CREATE TABLE file_search_text (
  file_id UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  search_text TEXT,
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(path, '') || ' ' || coalesce(search_text, ''))
  ) STORED
);

DO $$
DECLARE copied INTEGER;
BEGIN
  LOOP
    WITH batch AS (
      SELECT f.id, f.path, f.search_text
      FROM files f
      WHERE NOT EXISTS (SELECT 1 FROM file_search_text s WHERE s.file_id=f.id)
      ORDER BY f.id
      LIMIT 250
    )
    INSERT INTO file_search_text(file_id,path,search_text)
    SELECT id,path,search_text FROM batch;
    GET DIAGNOSTICS copied = ROW_COUNT;
    EXIT WHEN copied = 0;
  END LOOP;
END $$;

CREATE INDEX idx_file_search_text_fts ON file_search_text USING GIN(search_vector);

-- The queue trigger used to clear the payload through NEW.search_text. Keep the
-- metadata state on files, but clear the separately-owned payload directly.
CREATE OR REPLACE FUNCTION queue_file_search_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    INSERT INTO file_search_text(file_id,path,search_text) VALUES(NEW.id,NEW.path,NULL)
      ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,search_text=NULL;
    NEW.extracted_at := NULL;
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

CREATE OR REPLACE FUNCTION sync_file_search_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO file_search_text(file_id,path) VALUES(NEW.id,NEW.path)
    ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sync_file_search_path AFTER INSERT OR UPDATE OF path ON files
  FOR EACH ROW EXECUTE FUNCTION sync_file_search_path();

DROP INDEX IF EXISTS idx_files_search;
ALTER TABLE files DROP COLUMN search_vector;
ALTER TABLE files DROP COLUMN search_text;

-- A single monotonic marker lets the mount validate a cached tree without
-- rebuilding or transferring its multi-megabyte JSON document.
CREATE TABLE fuse_tree_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  revision BIGINT NOT NULL DEFAULT 1,
  CHECK(singleton)
);
INSERT INTO fuse_tree_state(singleton,revision) VALUES(TRUE,1) ON CONFLICT(singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_fuse_tree_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE fuse_tree_state SET revision=revision+1 WHERE singleton=TRUE;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_fuse_tree_files_insert AFTER INSERT ON files
  FOR EACH STATEMENT EXECUTE FUNCTION bump_fuse_tree_revision();
CREATE TRIGGER trg_fuse_tree_files_delete AFTER DELETE ON files
  FOR EACH STATEMENT EXECUTE FUNCTION bump_fuse_tree_revision();
CREATE TRIGGER trg_fuse_tree_files_update AFTER UPDATE OF collection_id,path,mime,size,current_version_id,deleted_at,updated_at ON files
  FOR EACH STATEMENT EXECUTE FUNCTION bump_fuse_tree_revision();
CREATE TRIGGER trg_fuse_tree_collections AFTER INSERT OR DELETE OR UPDATE ON collections
  FOR EACH STATEMENT EXECUTE FUNCTION bump_fuse_tree_revision();
CREATE TRIGGER trg_fuse_tree_folders AFTER INSERT OR DELETE OR UPDATE ON file_folders
  FOR EACH STATEMENT EXECUTE FUNCTION bump_fuse_tree_revision();
CREATE TRIGGER trg_fuse_tree_protected AFTER INSERT OR DELETE OR UPDATE ON files_protected_files
  FOR EACH STATEMENT EXECUTE FUNCTION bump_fuse_tree_revision();
