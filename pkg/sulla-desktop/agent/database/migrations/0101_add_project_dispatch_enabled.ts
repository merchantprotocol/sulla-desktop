// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Per-project switch for autonomous work. When false, the mechanical task
// dispatcher, review pool, in_progress reclaim, lane-entry automation, and
// the Heartbeat actionable queue all skip the project's tasks. Humans can
// still move cards by hand. Default true so existing projects are unchanged.
export const up = `
ALTER TABLE work_projects
  ADD COLUMN IF NOT EXISTS dispatch_enabled BOOLEAN NOT NULL DEFAULT TRUE;
`;

export const down = `
ALTER TABLE work_projects DROP COLUMN IF EXISTS dispatch_enabled;
`;
