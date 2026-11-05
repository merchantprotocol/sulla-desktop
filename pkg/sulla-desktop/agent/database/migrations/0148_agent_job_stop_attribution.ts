// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  ALTER TABLE agent_jobs
    ADD COLUMN IF NOT EXISTS stopped_by JSONB,
    ADD COLUMN IF NOT EXISTS stop_reason TEXT;
`;
export const down = `
  ALTER TABLE agent_jobs DROP COLUMN IF EXISTS stop_reason;
  ALTER TABLE agent_jobs DROP COLUMN IF EXISTS stopped_by;
`;
