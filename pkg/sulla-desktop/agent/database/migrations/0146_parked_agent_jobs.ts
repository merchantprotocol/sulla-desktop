// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Durable lifecycle state for hidden managers waiting on child jobs. */
export const up = `
  ALTER TABLE agent_jobs
    ADD COLUMN IF NOT EXISTS waiting_on_children INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS restart_resume_count INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_parked
    ON agent_jobs (status, parent_thread_id) WHERE status = 'parked';
`;

export const down = `
  DROP INDEX IF EXISTS idx_agent_jobs_parked;
  ALTER TABLE agent_jobs DROP COLUMN IF EXISTS restart_resume_count;
  ALTER TABLE agent_jobs DROP COLUMN IF EXISTS waiting_on_children;
`;
