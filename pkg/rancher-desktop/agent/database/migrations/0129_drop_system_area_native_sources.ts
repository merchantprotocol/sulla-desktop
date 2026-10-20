/**
 * Migration 0129 — remove native-source tracking for read-only system areas.
 *
 * The logs and training-data areas were registered file-by-file as two-way
 * "native sources" (one handle + one operation row per log file), which made
 * the native-source poll list ~19k rows several times a second and saturated
 * Postgres. System areas are read-only inputs and need no source tracking.
 * Only rows of the `logs` and `training-data` system collections are removed;
 * the files themselves and their versions/search data are untouched, and
 * user-selected native sources are never matched. Safe when the Files tables
 * (created by the Files service) do not exist yet.
 */
export const up = `
  DO $$
  BEGIN
    IF to_regclass('public.files_native_sources') IS NOT NULL
       AND to_regclass('public.files_native_source_operations') IS NOT NULL
       AND to_regclass('public.files') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'collections' AND column_name = 'system_area')
    THEN
      DELETE FROM files_native_source_operations o
       USING files f, collections c
       WHERE o.file_id = f.id AND f.collection_id = c.id
         AND c.system_area IN ('logs', 'training-data');
      DELETE FROM files_native_sources s
       USING collections c
       WHERE s.collection_id = c.id
         AND c.system_area IN ('logs', 'training-data');
    END IF;
  END $$;
`;

export const down = `
  SELECT 1;
`;
