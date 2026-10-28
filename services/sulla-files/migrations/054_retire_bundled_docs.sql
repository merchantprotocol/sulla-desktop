-- Copyright © 2026 Merchant Protocol, LLC.
-- SPDX-License-Identifier: GPL-2.0-or-later
--
-- Desktop no longer mirrors its bundled sulla-docs into Files: that knowledge now ships as the
-- memory seed pack and reaches agents through memory recall. Move the old mirror to Trash.
--
-- Scope, and nothing else: files under Docs/ whose CURRENT version is still the system mirror's
-- own write ('Mirrored from a Sulla system area', set only by the system-area mirror). The tree
-- may sit in the Sulla area or, after the main-tree move, in the user's own collection, so the
-- collection is not used to scope it. A file the user edited, imported or created has a different
-- current version and is never matched. Files under record retention or a lock are skipped.
--
-- This is a Trash, not a purge: like every Files delete, each file gets a new tombstone version
-- whose parent is the mirrored version, so the content stays restorable from Files history.
-- Folder rows are removed only for Docs folders left with no live files.
-- Idempotent: a second run matches no files and does nothing.

CREATE TEMP TABLE retired_bundled_docs ON COMMIT DROP AS
  SELECT f.id, f.collection_id, f.path, f.current_version_id,
         v.created_by_type, v.created_by_id, v.device_id
    FROM files f
    JOIN file_versions v ON v.id = f.current_version_id
   WHERE f.deleted_at IS NULL
     AND (f.path = 'Docs' OR f.path LIKE 'Docs/%')
     AND v.message = 'Mirrored from a Sulla system area'
     AND NOT files_retention_active(f);

CREATE TEMP TABLE retired_bundled_docs_tombstones ON COMMIT DROP AS
  SELECT r.id AS file_id, r.collection_id, r.path, gen_random_uuid() AS version_id,
         r.current_version_id, r.created_by_type, r.created_by_id, r.device_id
    FROM retired_bundled_docs r;

INSERT INTO file_versions(id, file_id, chunk_collection_id, parent_version_id, manifest_hash, size, deleted,
                          created_by_type, created_by_id, message, device_id, base_server_version_id)
SELECT t.version_id, t.file_id, t.collection_id, t.current_version_id, NULL, 0, TRUE,
       t.created_by_type, t.created_by_id, 'Moved to Trash: bundled Docs mirror retired', t.device_id,
       t.current_version_id
  FROM retired_bundled_docs_tombstones t;

UPDATE files f
   SET current_version_id = t.version_id, deleted_at = NOW(), updated_at = NOW()
  FROM retired_bundled_docs_tombstones t
 WHERE f.id = t.file_id;

INSERT INTO journal(collection_id, file_id, version_id, op)
SELECT collection_id, file_id, version_id, 'delete' FROM retired_bundled_docs_tombstones;

INSERT INTO audit_log(who_type, who_id, device_or_run_id, file_id, version_id, action, details)
SELECT 'service', 'sulla-files', 'sulla-files-migration', file_id, version_id,
       'bundled-docs-retired', jsonb_build_object('path', path, 'collectionId', collection_id)
  FROM retired_bundled_docs_tombstones;

-- Docs folder rows (and their descriptions) left with no live files.
DELETE FROM file_folders d
 WHERE (d.path = 'Docs' OR d.path LIKE 'Docs/%')
   AND EXISTS (SELECT 1 FROM retired_bundled_docs r WHERE r.collection_id = d.collection_id)
   AND NOT EXISTS (SELECT 1 FROM files f WHERE f.collection_id = d.collection_id AND f.deleted_at IS NULL
                    AND (f.path = d.path OR f.path LIKE d.path || '/%'));
