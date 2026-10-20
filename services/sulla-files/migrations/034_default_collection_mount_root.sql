-- The default Files collection is the mount root. Migration 029 only filled
-- NULL paths, so databases bootstrapped by an older Desktop could retain the
-- generated "Files--<id>" wrapper forever. Move any stale non-default owner of
-- the empty path aside before restoring the default mapping. System-area paths
-- are fixed names and never participate in this repair.
UPDATE collections
SET explorer_path = regexp_replace(name, '[\\/]+', '-', 'g') || '--' || left(id::text, 8)
WHERE NOT is_default
  AND system_area IS NULL
  AND explorer_path = ''
  AND EXISTS (
    SELECT 1 FROM collections default_collection
    WHERE default_collection.is_default
      AND coalesce(default_collection.org_id, '') = coalesce(collections.org_id, '')
      AND default_collection.owner_user_id = collections.owner_user_id
  );

UPDATE collections
SET explorer_path = ''
WHERE is_default
  AND system_area IS NULL
  AND explorer_path IS DISTINCT FROM '';
