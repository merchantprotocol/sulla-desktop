// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Agent-job polling indexes.
 *
 * pendingCompletions() runs on every completion-recovery tick. Its jsonpath
 * filter on the tasks column cannot use an index, so without a narrowing
 * predicate it detoasts the tasks of every historical job (seq scan, ~6 s on
 * ~3.9k rows). This partial index holds only rows whose completion has not been
 * acknowledged, ordered by the query's sort key, so the jsonpath filter runs on
 * that small slice instead of the whole table.
 */
export const up = `
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_undelivered_completion
    ON agent_jobs ((COALESCE(finished_at, created_at)))
    WHERE completion_delivered_at IS NULL
      AND status <> 'stopped'
      AND parent_channel IS NOT NULL
      AND parent_thread_id IS NOT NULL;
`;
export const down = `DROP INDEX IF EXISTS idx_agent_jobs_undelivered_completion;`;
