// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
export const up=`ALTER TABLE agent_job_wrap_up_requests
  ADD COLUMN IF NOT EXISTS execution_generation TEXT NOT NULL DEFAULT 'unavailable',
  ADD COLUMN IF NOT EXISTS reconciliation_outcome TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS agent_task_execution_identities(
  job_id TEXT NOT NULL,task_index INTEGER NOT NULL,identity JSONB,generation TEXT NOT NULL,
  launch_state TEXT NOT NULL DEFAULT 'active' CHECK(launch_state IN ('launching','active','failed')),
  failure_reason TEXT,recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),activated_at TIMESTAMPTZ,failed_at TIMESTAMPTZ,
  PRIMARY KEY(job_id,task_index,generation),FOREIGN KEY(job_id) REFERENCES agent_jobs(job_id) ON DELETE CASCADE);
UPDATE agent_job_wrap_up_requests SET reconciliation_outcome='manual-reconciliation',
  reconciliation_reason='Legacy wrap-up has no persisted execution identity; stop cannot be confirmed safely',reconciled_at=now()
  WHERE execution_generation='unavailable' AND completed_at IS NULL AND cancelled_at IS NULL` ;
export const down=`DROP TABLE IF EXISTS agent_task_execution_identities;ALTER TABLE agent_job_wrap_up_requests DROP COLUMN IF EXISTS reconciled_at,DROP COLUMN IF EXISTS reconciliation_reason,DROP COLUMN IF EXISTS reconciliation_outcome,DROP COLUMN IF EXISTS execution_generation`;
