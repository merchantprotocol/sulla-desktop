-- SPDX-License-Identifier: GPL-2.0-or-later
-- Keep manifest-referenced chunks present for every immutable/restorable version.
-- Per-chunk transaction advisory locks serialize version creation with GC deletion
-- without globally serializing unrelated chunk writes.
CREATE OR REPLACE FUNCTION files_guard_version_chunks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  chunk_id text;
BEGIN
  IF NEW.manifest_hash IS NULL THEN RETURN NEW; END IF;
  FOR chunk_id IN
    SELECT DISTINCT jsonb_array_elements_text(m.chunk_ids)
      FROM manifests m WHERE m.hash = NEW.manifest_hash
      ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.chunk_collection_id::text || ':' || chunk_id, 0));
    PERFORM 1 FROM chunks c WHERE c.collection_id=NEW.chunk_collection_id AND c.id=chunk_id FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'file version references missing chunk metadata: %', chunk_id USING ERRCODE='23503';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM manifests WHERE hash=NEW.manifest_hash) THEN
    RAISE EXCEPTION 'file version references missing manifest: %', NEW.manifest_hash USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION files_guard_chunk_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.collection_id::text || ':' || OLD.id, 0));
  IF EXISTS (
    SELECT 1 FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
     WHERE v.chunk_collection_id=OLD.collection_id AND m.chunk_ids ? OLD.id
  ) THEN
    RAISE EXCEPTION 'cannot delete chunk metadata referenced by a restorable file version: %', OLD.id USING ERRCODE='23503';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER files_guard_version_chunks
  BEFORE INSERT OR UPDATE OF manifest_hash,chunk_collection_id ON file_versions
  FOR EACH ROW EXECUTE FUNCTION files_guard_version_chunks();
CREATE TRIGGER files_guard_chunk_delete
  BEFORE DELETE ON chunks
  FOR EACH ROW EXECUTE FUNCTION files_guard_chunk_delete();

-- Both guards (and the reconciler) look up "which retained versions reference
-- chunk X". Without these, every chunk delete scans every manifest, which
-- stalls GC once a library reaches hundreds of thousands of files.
CREATE INDEX IF NOT EXISTS idx_manifests_chunk_ids_gin ON manifests USING gin (chunk_ids);
CREATE INDEX IF NOT EXISTS idx_file_versions_collection_manifest
  ON file_versions (chunk_collection_id, manifest_hash) WHERE manifest_hash IS NOT NULL;
