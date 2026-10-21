-- Derived search data only: never delete files, versions, manifests or content.
-- The migration runner owns the transaction; bounded batches limit working
-- memory and lock_timeout makes contention fail/retry on the next startup.
SET LOCAL lock_timeout = '5s';

-- Every writer updates current_version_id, not just system-area ingest. The
-- ingest header cannot be the authority for whether an area is searchable.
CREATE OR REPLACE FUNCTION queue_file_search_index() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unindexed BOOLEAN;
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    SELECT coalesce(system_area IN ('logs','training-data'),FALSE) INTO unindexed FROM collections WHERE id=NEW.collection_id;
    IF unindexed THEN
      DELETE FROM file_search_text WHERE file_id=NEW.id;
    ELSE
      INSERT INTO file_search_text(file_id,path,search_text) VALUES(NEW.id,NEW.path,NULL)
        ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,search_text=NULL;
    END IF;
    NEW.extracted_at := NULL;
    NEW.extraction_status := CASE WHEN NEW.deleted_at IS NULL AND NOT unindexed THEN 'pending' ELSE 'unsupported' END;
    NEW.extraction_reason_code := CASE WHEN unindexed THEN 'system_area_unindexed' WHEN NEW.deleted_at IS NULL THEN 'queued' ELSE 'deleted' END;
    NEW.extraction_reason := CASE WHEN unindexed THEN 'System-area files are stored without search indexing.' WHEN NEW.deleted_at IS NULL THEN 'Waiting for local indexing.' ELSE 'Deleted files are not indexed.' END;
    IF NOT unindexed AND NEW.deleted_at IS NULL AND NEW.current_version_id IS NOT NULL THEN
      INSERT INTO file_index_jobs(file_id,version_id,status,reason_code,reason)
      VALUES(NEW.id,NEW.current_version_id,'pending','queued','Waiting for local indexing.')
      ON CONFLICT(version_id) DO UPDATE SET status='pending',attempts=0,last_error=NULL,available_at=NOW(),started_at=NULL,finished_at=NULL,reason_code='queued',reason='Waiting for local indexing.';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION sync_file_search_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM collections WHERE id=NEW.collection_id AND system_area IN ('logs','training-data')) THEN
    DELETE FROM file_search_text WHERE file_id=NEW.id;
  ELSE
    INSERT INTO file_search_text(file_id,path) VALUES(NEW.id,NEW.path)
      ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path;
  END IF;
  RETURN NEW;
END $$;

-- Covers direct queue writers too (copy/restore/retry), including old clients.
CREATE OR REPLACE FUNCTION guard_file_search_index_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM files f JOIN collections c ON c.id=f.collection_id
    WHERE f.id=NEW.file_id AND c.system_area IN ('logs','training-data')) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_file_search_index_job BEFORE INSERT OR UPDATE ON file_index_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_file_search_index_job();

DO $$
DECLARE removed INTEGER; cursor_id UUID := '00000000-0000-0000-0000-000000000000';
BEGIN
  LOOP
    WITH batch AS MATERIALIZED (
      SELECT sc.id FROM file_search_chunks sc JOIN files f ON f.id=sc.file_id
      JOIN collections c ON c.id=f.collection_id
      WHERE sc.id>cursor_id AND (c.system_area IN ('logs','training-data') OR sc.version_id IS DISTINCT FROM f.current_version_id)
      ORDER BY sc.id LIMIT 1000
    ), deleted AS (
      DELETE FROM file_search_chunks sc USING batch b WHERE sc.id=b.id RETURNING sc.id
    )
    SELECT count(*),max(id::text)::uuid INTO removed,cursor_id FROM deleted;
    EXIT WHEN removed=0;
  END LOOP;
  LOOP
    WITH batch AS MATERIALIZED (
      SELECT s.file_id FROM file_search_text s JOIN files f ON f.id=s.file_id
      JOIN collections c ON c.id=f.collection_id WHERE c.system_area IN ('logs','training-data') LIMIT 250
    )
    DELETE FROM file_search_text s USING batch b WHERE s.file_id=b.file_id;
    GET DIAGNOSTICS removed = ROW_COUNT;
    EXIT WHEN removed=0;
  END LOOP;
  LOOP
    WITH batch AS MATERIALIZED (
      SELECT j.version_id FROM file_index_jobs j JOIN files f ON f.id=j.file_id
      JOIN collections c ON c.id=f.collection_id
      WHERE c.system_area IN ('logs','training-data') OR j.version_id IS DISTINCT FROM f.current_version_id
      LIMIT 1000
    )
    DELETE FROM file_index_jobs j USING batch b WHERE j.version_id=b.version_id;
    GET DIAGNOSTICS removed = ROW_COUNT;
    EXIT WHEN removed=0;
  END LOOP;
END $$;
