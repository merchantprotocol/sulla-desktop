// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up=`ALTER TABLE agent_job_wrap_up_requests
  ADD COLUMN IF NOT EXISTS teardown_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS teardown_last_error TEXT,
  ADD COLUMN IF NOT EXISTS teardown_deadline_at TIMESTAMPTZ;
UPDATE agent_job_wrap_up_requests
  SET teardown_deadline_at=COALESCE(teardown_deadline_at,created_at+interval '5 minutes')
  WHERE completed_at IS NULL AND cancelled_at IS NULL AND reconciliation_outcome IS NULL;
ALTER TABLE agent_job_wrap_up_requests
  ALTER COLUMN teardown_deadline_at SET DEFAULT (now()+interval '5 minutes')`;

export const down=`ALTER TABLE agent_job_wrap_up_requests
  DROP COLUMN IF EXISTS teardown_deadline_at,
  DROP COLUMN IF EXISTS teardown_last_error,
  DROP COLUMN IF EXISTS teardown_attempts`;
