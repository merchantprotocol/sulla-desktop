// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  CREATE TABLE IF NOT EXISTS agent_stranded_episodes (
    manager_job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    manager_task_index INTEGER NOT NULL,
    state_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
    attempts INTEGER NOT NULL DEFAULT 0,
    parent_channel TEXT NOT NULL,
    parent_thread_id TEXT NOT NULL,
    label TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    PRIMARY KEY (manager_job_id, manager_task_index, state_key)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_stranded_episodes_pending
    ON agent_stranded_episodes (created_at) WHERE status = 'pending';
`;

export const down = `DROP TABLE IF EXISTS agent_stranded_episodes;`;
