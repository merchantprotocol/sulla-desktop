-- Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
-- Licensed under the Sulla Fair-Code License. See LICENSE.
--
-- Retire the old bundled Docs mirror. Only files whose current version is still the
-- system mirror are touched; user-created or edited files remain visible and are logged.
-- The existing version is marked deleted so the tree stays restorable through Files history.

CREATE TEMP TABLE retired_bundled_docs ON COMMIT DROP AS
  SELECT f.id, f.collection_id, f.path, f.current_version_id
    FROM files f
    JOIN collections c ON c.id = f.collection_id AND c.system_area = 'sulla'
    JOIN file_versions v ON v.id = f.current_version_id
   WHERE f.deleted_at IS NULL
     AND (f.path = 'Docs' OR f.path LIKE 'Docs/%')
     AND v.message = 'Mirrored from a Sulla system area';

UPDATE file_versions v
   SET deleted = TRUE,
       size = 0,
       message = 'Moved to Trash: bundled Docs mirror retired'
 WHERE v.id IN (SELECT current_version_id FROM retired_bundled_docs);

UPDATE files f
   SET deleted_at = NOW(), updated_at = NOW()
 WHERE f.id IN (SELECT id FROM retired_bundled_docs);

INSERT INTO journal(collection_id, file_id, version_id, op)
SELECT collection_id, id, current_version_id, 'delete' FROM retired_bundled_docs;

INSERT INTO audit_log(who_type, who_id, device_or_run_id, file_id, version_id, action, details)
SELECT 'service', 'sulla-files', 'sulla-files-migration', id, current_version_id,
       'bundled-docs-retired', jsonb_build_object('path', path)
  FROM retired_bundled_docs;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM files f JOIN collections c ON c.id=f.collection_id
             WHERE c.system_area='sulla' AND f.deleted_at IS NULL
               AND (f.path='Docs' OR f.path LIKE 'Docs/%')) THEN
    RAISE NOTICE 'Bundled Docs retirement left user-created or edited files untouched';
  END IF;
END $$;
