// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  CREATE TABLE IF NOT EXISTS agent_task_waits (
    job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index INTEGER NOT NULL CHECK (task_index >= 0),
    wake_at TIMESTAMPTZ NOT NULL,
    reason TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('scheduled', 'claimed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, task_index)
  );
  CREATE INDEX IF NOT EXISTS agent_task_waits_due_idx ON agent_task_waits (wake_at) WHERE state = 'scheduled';
`;

export const down = `DROP TABLE IF EXISTS agent_task_waits;`;
