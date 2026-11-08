// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
export const up=`ALTER TABLE agent_job_wrap_up_requests ADD COLUMN IF NOT EXISTS execution_generation TEXT NOT NULL DEFAULT 'unavailable';
CREATE TABLE IF NOT EXISTS agent_task_execution_identities(
  job_id TEXT NOT NULL,task_index INTEGER NOT NULL,identity JSONB NOT NULL,generation TEXT NOT NULL,recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,task_index,generation),FOREIGN KEY(job_id) REFERENCES agent_jobs(job_id) ON DELETE CASCADE)`;
export const down=`DROP TABLE IF EXISTS agent_task_execution_identities;ALTER TABLE agent_job_wrap_up_requests DROP COLUMN IF EXISTS execution_generation`;
