// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `
  CREATE TABLE IF NOT EXISTS agent_job_heartbeats (
    job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index INTEGER NOT NULL CHECK (task_index >= 0),
    thread_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    config JSONB NOT NULL,
    started_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    set_by TEXT NOT NULL CHECK (set_by IN ('agent', 'human', 'manager')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, task_index),
    CHECK (expires_at > started_at)
  );
  CREATE INDEX IF NOT EXISTS agent_job_heartbeats_expiry_idx ON agent_job_heartbeats (expires_at);
`;

export const down = `DROP TABLE IF EXISTS agent_job_heartbeats;`;
