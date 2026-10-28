-- SPDX-License-Identifier: GPL-2.0-or-later
-- Hot joins observed in residency/preview and folder operations.
-- These are additive and safe for existing volumes; IF NOT EXISTS keeps
-- upgrades idempotent across installs that already have equivalent indexes.
CREATE INDEX IF NOT EXISTS idx_files_current_version ON files(current_version_id) WHERE current_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_versions_parent ON file_versions(parent_version_id) WHERE parent_version_id IS NOT NULL;
