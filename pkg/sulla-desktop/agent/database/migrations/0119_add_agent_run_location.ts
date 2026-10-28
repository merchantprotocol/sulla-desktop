// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS run_location TEXT NOT NULL DEFAULT 'vm'
      CHECK (run_location IN ('vm', 'container'));
`;

export const down = `
  ALTER TABLE agent_definitions DROP COLUMN IF EXISTS run_location;
`;
