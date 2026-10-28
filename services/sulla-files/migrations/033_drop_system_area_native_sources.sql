-- SPDX-License-Identifier: GPL-2.0-or-later
-- System areas (logs, training data, Sulla docs/use cases) are read-only inputs ingested as plain files
-- (PUT /v1/local/system-areas/ingest). Remove the native-source tracking an earlier Desktop scan created
-- for them. Only rows of system-area collections match: user-picked native sources live in ordinary
-- collections and are never touched. The files, versions and search data stay as they are.
-- (Desktop migration 0129 already removed the logs/training-data rows; this also covers the Sulla area
-- and databases where that Desktop migration has not run.)
DELETE FROM files_native_source_operations o
 USING files f, collections c
 WHERE o.file_id = f.id AND f.collection_id = c.id AND c.system_area IS NOT NULL;
DELETE FROM files_native_sources s
 USING collections c
 WHERE s.collection_id = c.id AND c.system_area IS NOT NULL;
