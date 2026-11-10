// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export const up = `
  CREATE TABLE IF NOT EXISTS agent_job_review_items (
    job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'closed')),
    closure_kind TEXT CHECK (closure_kind IN ('fixed', 'wont_fix')),
    commit_sha TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_by TEXT CHECK (closed_by IN ('worker', 'manager')),
    PRIMARY KEY (job_id, task_index, item_id),
    CHECK ((status = 'closed') = (closure_kind IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_agent_job_review_items_open
    ON agent_job_review_items (job_id, task_index) WHERE status <> 'closed';
`;

export const down = `DROP TABLE IF EXISTS agent_job_review_items;`;
