-- Durable, privacy-safe current-version indexing outcomes. Reasons are fixed
-- operator-facing summaries; extractor stderr and file content are never stored.
ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_reason_code TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS extraction_reason TEXT;
ALTER TABLE file_index_jobs ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE file_index_jobs ADD COLUMN IF NOT EXISTS reason TEXT;

UPDATE files
SET extraction_status='pending', extraction_reason_code='queue_repaired', extraction_reason='Waiting for local indexing.'
WHERE deleted_at IS NULL AND current_version_id IS NOT NULL
  AND extraction_status NOT IN ('pending','indexing','indexed','failed','unsupported');

INSERT INTO file_index_jobs(file_id,version_id,status,reason_code,reason)
SELECT f.id,f.current_version_id,'pending','queue_repaired','Waiting for local indexing.'
FROM files f
LEFT JOIN file_index_jobs j ON j.version_id=f.current_version_id
WHERE f.deleted_at IS NULL AND f.current_version_id IS NOT NULL AND j.version_id IS NULL
ON CONFLICT(version_id) DO NOTHING;

CREATE OR REPLACE FUNCTION queue_file_search_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.search_text := NULL; NEW.extracted_at := NULL;
    NEW.extraction_status := CASE WHEN NEW.deleted_at IS NULL THEN 'pending' ELSE 'unsupported' END;
    NEW.extraction_reason_code := CASE WHEN NEW.deleted_at IS NULL THEN 'queued' ELSE 'deleted' END;
    NEW.extraction_reason := CASE WHEN NEW.deleted_at IS NULL THEN 'Waiting for local indexing.' ELSE 'Deleted files are not indexed.' END;
    DELETE FROM file_search_chunks WHERE file_id=NEW.id;
    DELETE FROM file_index_jobs WHERE file_id=NEW.id;
    IF NEW.deleted_at IS NULL AND NEW.current_version_id IS NOT NULL THEN
      INSERT INTO file_index_jobs(file_id,version_id,status,reason_code,reason)
      VALUES(NEW.id,NEW.current_version_id,'pending','queued','Waiting for local indexing.');
    END IF;
  END IF;
  RETURN NEW;
END $$;
