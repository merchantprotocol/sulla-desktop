// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up=`ALTER TABLE agent_job_wrap_up_requests
  ADD COLUMN IF NOT EXISTS claim_token TEXT,
  ADD COLUMN IF NOT EXISTS claim_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS teardown_needed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS teardown_acknowledged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS agent_job_wrap_up_due_claim_idx
  ON agent_job_wrap_up_requests(due_at,claim_expires_at)
  WHERE completed_at IS NULL AND cancelled_at IS NULL`;

export const down=`DROP INDEX IF EXISTS agent_job_wrap_up_due_claim_idx;
ALTER TABLE agent_job_wrap_up_requests DROP COLUMN IF EXISTS teardown_acknowledged_at,DROP COLUMN IF EXISTS teardown_needed_at,DROP COLUMN IF EXISTS claim_expires_at,DROP COLUMN IF EXISTS claim_version,DROP COLUMN IF EXISTS claim_token`;
