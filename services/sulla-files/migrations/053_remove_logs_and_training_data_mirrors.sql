-- Copyright © 2026 Merchant Protocol, LLC.
-- SPDX-License-Identifier: GPL-2.0-or-later
--
-- Desktop no longer mirrors its app logs (Logs/app/...) or its conversation transcripts (the
-- Training Data system collection) into Files, and nothing mounts them any more. Purge those
-- app-owned mirror files.
--
-- Scope, and nothing else:
--   * every file of the collection whose system_area = 'training-data';
--   * files of the collection whose system_area = 'logs' at path 'app' or under 'app/'.
-- The user's own collections are never matched (system_area IS NULL), the Sulla area is never
-- matched, and the Logs collection itself stays: its audit/files and audit/vault trail is the
-- Files audit store (FileAuditWriter) and is kept untouched. Files under record retention or a
-- record lock are skipped, never forced.
--
-- This removes metadata like a permanent purge does (journal rows, share links, versions and
-- everything that cascades from them) and queues the freed chunks in file_chunk_gc, which the
-- service drains at startup to delete the encrypted chunk blobs. The then-empty Training Data
-- collection row is dropped at startup by retiredSystemAreas.ts, once its blobs are gone.
-- Idempotent: a second run matches no files and does nothing.

CREATE TEMP TABLE retired_mirror_files ON COMMIT DROP AS
  SELECT f.id
    FROM files f
    JOIN collections c ON c.id = f.collection_id
   WHERE (c.system_area = 'training-data'
          OR (c.system_area = 'logs' AND (f.path = 'app' OR f.path LIKE 'app/%')))
     AND NOT files_retention_active(f);

CREATE TEMP TABLE retired_mirror_versions ON COMMIT DROP AS
  SELECT v.id FROM file_versions v JOIN retired_mirror_files r ON r.id = v.file_id;

CREATE TEMP TABLE retired_mirror_chunks ON COMMIT DROP AS
  SELECT DISTINCT v.chunk_collection_id AS collection_id, jsonb_array_elements_text(m.chunk_ids) AS chunk_id
    FROM file_versions v
    JOIN retired_mirror_files r ON r.id = v.file_id
    JOIN manifests m ON m.hash = v.manifest_hash;

-- Rows that reference these files or versions without ON DELETE CASCADE.
DELETE FROM journal
 WHERE file_id IN (SELECT id FROM retired_mirror_files)
    OR version_id IN (SELECT id FROM retired_mirror_versions);
UPDATE audit_log SET file_id = NULL, version_id = NULL
 WHERE file_id IN (SELECT id FROM retired_mirror_files)
    OR version_id IN (SELECT id FROM retired_mirror_versions);
DELETE FROM file_share_links WHERE file_id IN (SELECT id FROM retired_mirror_files);
DELETE FROM file_residency WHERE version_id IN (SELECT id FROM retired_mirror_versions);
DELETE FROM files_legacy_version_map WHERE source_version_id IN (SELECT id FROM retired_mirror_versions);
DELETE FROM files_legacy_file_map WHERE source_file_id IN (SELECT id FROM retired_mirror_files);

-- Versions, search rows, index jobs, previews, residency and the rest cascade from files.
DELETE FROM files WHERE id IN (SELECT id FROM retired_mirror_files);

-- Physical chunk cleanup goes through the existing queue: the drainer re-counts references and
-- deletes a blob only when no remaining version uses it.
WITH removal AS (
  INSERT INTO audit_log(who_type, who_id, action, details)
  SELECT 'service', 'sulla-files', 'system-area-mirror-removal', jsonb_build_object(
           'areas', jsonb_build_array('training-data', 'logs/app'),
           'files', (SELECT count(*) FROM retired_mirror_files),
           'versions', (SELECT count(*) FROM retired_mirror_versions),
           'chunks', (SELECT count(*) FROM retired_mirror_chunks))
   WHERE EXISTS (SELECT 1 FROM retired_mirror_files)
  RETURNING id
)
INSERT INTO file_chunk_gc(collection_id, chunk_id, audit_id)
SELECT k.collection_id, k.chunk_id, removal.id
  FROM retired_mirror_chunks k CROSS JOIN removal
    ON CONFLICT (collection_id, chunk_id) DO UPDATE
   SET audit_id = EXCLUDED.audit_id, requested_at = NOW(), last_error = NULL;

-- The folder rows of the removed trees (empty folders included).
DELETE FROM file_folders d
 USING collections c
 WHERE c.id = d.collection_id
   AND (c.system_area = 'training-data'
        OR (c.system_area = 'logs' AND (d.path = 'app' OR d.path LIKE 'app/%')))
   AND NOT EXISTS (SELECT 1 FROM files f WHERE f.collection_id = d.collection_id
                    AND (f.path = d.path OR f.path LIKE d.path || '/%'));
