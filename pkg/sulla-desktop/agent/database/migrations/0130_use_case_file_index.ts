// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Links each runtime definition to the published Files version that produced it. */
export const up = `
  ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS use_case_file_id UUID, ADD COLUMN IF NOT EXISTS use_case_version_id UUID;
  ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS use_case_file_id UUID, ADD COLUMN IF NOT EXISTS use_case_version_id UUID;
  ALTER TABLE workflows ADD COLUMN IF NOT EXISTS use_case_file_id UUID, ADD COLUMN IF NOT EXISTS use_case_version_id UUID;
  ALTER TABLE function_definitions ADD COLUMN IF NOT EXISTS use_case_file_id UUID, ADD COLUMN IF NOT EXISTS use_case_version_id UUID, ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE recipe_definitions ADD COLUMN IF NOT EXISTS use_case_file_id UUID, ADD COLUMN IF NOT EXISTS use_case_version_id UUID, ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
  CREATE TABLE IF NOT EXISTS use_case_files_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    initial_export_completed_at TIMESTAMPTZ,
    last_scan_at TIMESTAMPTZ,
    last_error TEXT
  );
  INSERT INTO use_case_files_state(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;
`;

// Additive by design: rolling back code must not erase provenance or export state.
export const down = ``;
