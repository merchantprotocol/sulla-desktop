// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up=`ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS launch_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_launch_key_unique ON agent_jobs(launch_key) WHERE launch_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_lead_replacements (
  old_job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
  old_task_index INTEGER NOT NULL,
  launch_key TEXT NOT NULL UNIQUE,
  replacement_agent_id TEXT NOT NULL,
  replacement_job_id TEXT,
  replacement_task_index INTEGER,
  replacement_thread_id TEXT,
  phase TEXT NOT NULL DEFAULT 'intent' CHECK (phase IN ('intent','launched','children_moved','wrapped')),
  child_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  audit_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  audit_done BOOLEAN NOT NULL DEFAULT FALSE,
  wrap_up_done BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(old_job_id,old_task_index)
)`;
export const down=`DROP TABLE IF EXISTS agent_lead_replacements; DROP INDEX IF EXISTS agent_jobs_launch_key_unique; ALTER TABLE agent_jobs DROP COLUMN IF EXISTS launch_key`;
