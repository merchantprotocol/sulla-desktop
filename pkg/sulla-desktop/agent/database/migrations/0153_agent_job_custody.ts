// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  CREATE TABLE IF NOT EXISTS agent_job_custody (
    job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index INTEGER CHECK (task_index IS NULL OR task_index >= 0),
    owner_channel TEXT NOT NULL,
    owner_thread_id TEXT NOT NULL,
    owner_agent_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_job_custody_job_scope_uq
    ON agent_job_custody (job_id) WHERE task_index IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS agent_job_custody_task_scope_uq
    ON agent_job_custody (job_id, task_index) WHERE task_index IS NOT NULL;
  CREATE INDEX IF NOT EXISTS agent_job_custody_owner_idx
    ON agent_job_custody (owner_thread_id, job_id);

  CREATE TABLE IF NOT EXISTS agent_job_custody_audit (
    id BIGSERIAL PRIMARY KEY,
    job_id TEXT NOT NULL,
    task_index INTEGER CHECK (task_index IS NULL OR task_index >= 0),
    from_channel TEXT NOT NULL,
    from_thread_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_channel TEXT NOT NULL,
    to_thread_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    changed_by_kind TEXT NOT NULL CHECK (changed_by_kind IN ('human','agent')),
    changed_by_channel TEXT,
    changed_by_thread_id TEXT,
    changed_by_agent_id TEXT,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    version INTEGER NOT NULL CHECK (version >= 1),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_job_custody_audit_job_scope_uq
    ON agent_job_custody_audit (job_id, version) WHERE task_index IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS agent_job_custody_audit_task_scope_uq
    ON agent_job_custody_audit (job_id, task_index, version) WHERE task_index IS NOT NULL;
  CREATE INDEX IF NOT EXISTS agent_job_custody_audit_history_idx
    ON agent_job_custody_audit (job_id, changed_at, id);
`;

export const down = `
  DROP TABLE IF EXISTS agent_job_custody_audit;
  DROP TABLE IF EXISTS agent_job_custody;
`;
