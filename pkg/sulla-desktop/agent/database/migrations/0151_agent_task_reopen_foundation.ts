// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  CREATE TABLE IF NOT EXISTS agent_job_task_reopens (
    job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index INTEGER NOT NULL CHECK (task_index >= 0),
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
    reopen_count INTEGER NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
    lease_id TEXT,
    lease_acquired_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, task_index),
    CHECK ((lease_id IS NULL) = (lease_acquired_at IS NULL))
  );

  CREATE TABLE IF NOT EXISTS agent_job_result_history (
    job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index INTEGER NOT NULL CHECK (task_index >= 0),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    task_status TEXT NOT NULL,
    result JSONB,
    completion JSONB,
    summary TEXT,
    returned_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    completion_delivered_at TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, task_index, generation)
  );
`;

export const down = `
  DROP TABLE IF EXISTS agent_job_result_history;
  DROP TABLE IF EXISTS agent_job_task_reopens;
`;
