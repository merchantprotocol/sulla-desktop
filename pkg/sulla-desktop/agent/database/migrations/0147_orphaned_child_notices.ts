// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Durable audit trail for children that settle after their manager is terminal. */
export const up = `
  ALTER TABLE agent_jobs
    ADD COLUMN IF NOT EXISTS orphaned_child_notices JSONB NOT NULL DEFAULT '[]'::jsonb;
`;

export const down = `
  ALTER TABLE agent_jobs DROP COLUMN IF EXISTS orphaned_child_notices;
`;
