-- SPDX-License-Identifier: GPL-2.0-or-later
-- Transcript metadata is derived plaintext and follows the same eligibility
-- boundary as the search index.

CREATE OR REPLACE FUNCTION purge_file_recording_derivatives(target_file_id UUID) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM recording_metadata WHERE file_id=target_file_id;
  DELETE FROM recording_enrichment_jobs WHERE file_id=target_file_id;
END $$;

CREATE OR REPLACE FUNCTION purge_protected_file_search_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM file_search_text WHERE file_id=NEW.file_id;
  DELETE FROM file_search_chunks WHERE file_id=NEW.file_id;
  DELETE FROM file_index_jobs WHERE file_id=NEW.file_id;
  PERFORM purge_file_recording_derivatives(NEW.file_id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION purge_ineligible_file_recording_derivatives() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM file_search_text WHERE file_id=NEW.id;
    DELETE FROM file_search_chunks WHERE file_id=NEW.id;
    DELETE FROM file_index_jobs WHERE file_id=NEW.id;
    PERFORM purge_file_recording_derivatives(NEW.id);
  ELSIF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    DELETE FROM recording_metadata WHERE file_id=NEW.id AND version_id IS DISTINCT FROM NEW.current_version_id;
    DELETE FROM recording_enrichment_jobs WHERE file_id=NEW.id AND version_id IS DISTINCT FROM NEW.current_version_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_purge_ineligible_file_recording_derivatives
  AFTER UPDATE OF current_version_id,deleted_at ON files
  FOR EACH ROW EXECUTE FUNCTION purge_ineligible_file_recording_derivatives();

CREATE OR REPLACE FUNCTION purge_unindexed_collection_derivatives() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.system_area='logs' AND NEW.system_area IS DISTINCT FROM OLD.system_area THEN
    DELETE FROM file_search_text WHERE file_id IN (SELECT id FROM files WHERE collection_id=NEW.id);
    DELETE FROM file_search_chunks WHERE file_id IN (SELECT id FROM files WHERE collection_id=NEW.id);
    DELETE FROM file_index_jobs WHERE file_id IN (SELECT id FROM files WHERE collection_id=NEW.id);
    DELETE FROM recording_metadata WHERE file_id IN (SELECT id FROM files WHERE collection_id=NEW.id);
    DELETE FROM recording_enrichment_jobs WHERE file_id IN (SELECT id FROM files WHERE collection_id=NEW.id);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_purge_unindexed_collection_derivatives
  AFTER UPDATE OF system_area ON collections
  FOR EACH ROW EXECUTE FUNCTION purge_unindexed_collection_derivatives();

DELETE FROM recording_metadata m USING files f,collections c
WHERE m.file_id=f.id AND c.id=f.collection_id
  AND (f.deleted_at IS NOT NULL OR c.system_area='logs'
    OR EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
    OR f.current_version_id IS DISTINCT FROM m.version_id);
DELETE FROM recording_enrichment_jobs j USING files f,collections c
WHERE j.file_id=f.id AND c.id=f.collection_id
  AND (f.deleted_at IS NOT NULL OR c.system_area='logs'
    OR EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
    OR f.current_version_id IS DISTINCT FROM j.version_id);
