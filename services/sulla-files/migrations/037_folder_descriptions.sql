-- SPDX-License-Identifier: GPL-2.0-or-later
-- Human- and agent-authored placement guidance for collection roots and folders.
-- Descriptions guide agents without restricting where they may save files.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS naming_hint TEXT;
ALTER TABLE file_folders ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE file_folders ADD COLUMN IF NOT EXISTS naming_hint TEXT;

ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_description_length;
ALTER TABLE collections ADD CONSTRAINT collections_description_length CHECK (description IS NULL OR length(description) <= 2000);
ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_naming_hint_length;
ALTER TABLE collections ADD CONSTRAINT collections_naming_hint_length CHECK (naming_hint IS NULL OR length(naming_hint) <= 500);
ALTER TABLE file_folders DROP CONSTRAINT IF EXISTS file_folders_description_length;
ALTER TABLE file_folders ADD CONSTRAINT file_folders_description_length CHECK (description IS NULL OR length(description) <= 2000);
ALTER TABLE file_folders DROP CONSTRAINT IF EXISTS file_folders_naming_hint_length;
ALTER TABLE file_folders ADD CONSTRAINT file_folders_naming_hint_length CHECK (naming_hint IS NULL OR length(naming_hint) <= 500);
