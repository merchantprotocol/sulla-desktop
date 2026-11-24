// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  ALTER TABLE subject_memory.episodes
    ADD COLUMN IF NOT EXISTS checkin_key text NULL,
    ADD COLUMN IF NOT EXISTS superseded_by text NULL,
    ADD COLUMN IF NOT EXISTS superseded_ts bigint NULL,
    ADD COLUMN IF NOT EXISTS superseded_reason text NULL;

  CREATE INDEX IF NOT EXISTS subject_memory_episodes_active_checkin_key
    ON subject_memory.episodes (checkin_key)
    WHERE checkin_key IS NOT NULL AND superseded_by IS NULL;
`;

export const down = '';
