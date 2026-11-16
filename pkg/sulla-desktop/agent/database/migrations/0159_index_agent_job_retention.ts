// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Narrow the hourly, bounded cleanup to old terminal rows. */
export const up = `
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_retention_terminal
    ON agent_jobs (finished_at, job_id)
    WHERE status IN ('completed', 'failed', 'stopped')
      AND finished_at IS NOT NULL AND waiting_on_children = 0;
`;

export const down = `DROP INDEX IF EXISTS idx_agent_jobs_retention_terminal;`;
