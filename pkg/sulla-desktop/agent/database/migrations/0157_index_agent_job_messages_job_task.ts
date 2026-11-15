// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Adopt the index created during the 2026-11-13 Files incident. */
export const up = `CREATE INDEX IF NOT EXISTS idx_agent_job_messages_job_task ON agent_job_messages (job_id, task_index);`;
export const down = `DROP INDEX IF EXISTS idx_agent_job_messages_job_task;`;
