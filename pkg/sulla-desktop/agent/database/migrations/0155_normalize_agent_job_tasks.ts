// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Indexed, typed ownership rows for Live Agents. JSON remains the opaque task
 * record for lifecycle hydration; projection filtering and ancestry use only
 * these columns. The trigger makes every existing JSON lifecycle write atomic
 * with its relational projection, including CAS and restart-recovery writes.
 */
export const up = `
  CREATE TABLE IF NOT EXISTS agent_job_tasks (
    job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index INTEGER NOT NULL,
    task_status TEXT NOT NULL,
    thread_id TEXT,
    agent_id TEXT,
    label TEXT,
    visibility TEXT,
    started_at_ms BIGINT,
    finished_at_ms BIGINT,
    returned_at_ms BIGINT,
    wake_at_ms BIGINT,
    dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    summary TEXT,
    wait_reason TEXT,
    stopped_by JSONB,
    stop_reason TEXT,
    PRIMARY KEY (job_id, task_index)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_job_tasks_thread ON agent_job_tasks(thread_id) WHERE thread_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_agent_job_tasks_status ON agent_job_tasks(task_status, job_id);
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_projection_active ON agent_jobs(job_id) WHERE status IN ('running', 'parked');
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_projection_finished ON agent_jobs(finished_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_projection_created ON agent_jobs(created_at DESC);

  CREATE OR REPLACE FUNCTION sync_agent_job_task_rows() RETURNS trigger AS $$
  BEGIN
    INSERT INTO agent_job_tasks
      (job_id, task_index, task_status, thread_id, agent_id, label, visibility,
       started_at_ms, finished_at_ms, returned_at_ms, wake_at_ms, dismissed,
       summary, wait_reason, stopped_by, stop_reason)
    SELECT NEW.job_id, (entry.ordinality - 1)::integer,
      COALESCE(entry.task->>'status', 'queued'), entry.task->>'threadId',
      entry.task->>'agentId', entry.task->>'label', entry.task->>'visibility',
      NULLIF(entry.task->>'startedAt', '')::bigint,
      NULLIF(entry.task->>'finishedAt', '')::bigint,
      NULLIF(entry.task->>'returnedAt', '')::bigint,
      NULLIF(entry.task->>'wakeAt', '')::bigint,
      COALESCE((entry.task->>'dismissed')::boolean, FALSE), entry.task->>'summary',
      entry.task->>'waitReason', entry.task->'stoppedBy', entry.task->>'stopReason'
    FROM jsonb_array_elements(COALESCE(NEW.tasks, '[]'::jsonb)) WITH ORDINALITY AS entry(task, ordinality)
    ON CONFLICT (job_id, task_index) DO UPDATE SET
      task_status = EXCLUDED.task_status, thread_id = EXCLUDED.thread_id, agent_id = EXCLUDED.agent_id,
      label = EXCLUDED.label, visibility = EXCLUDED.visibility, started_at_ms = EXCLUDED.started_at_ms,
      finished_at_ms = EXCLUDED.finished_at_ms, returned_at_ms = EXCLUDED.returned_at_ms,
      wake_at_ms = EXCLUDED.wake_at_ms, dismissed = EXCLUDED.dismissed, summary = EXCLUDED.summary,
      wait_reason = EXCLUDED.wait_reason, stopped_by = EXCLUDED.stopped_by, stop_reason = EXCLUDED.stop_reason;
    DELETE FROM agent_job_tasks
      WHERE job_id = NEW.job_id AND task_index >= jsonb_array_length(COALESCE(NEW.tasks, '[]'::jsonb));
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_sync_agent_job_task_rows ON agent_jobs;
  CREATE TRIGGER trg_sync_agent_job_task_rows
    AFTER INSERT OR UPDATE OF tasks ON agent_jobs
    FOR EACH ROW EXECUTE FUNCTION sync_agent_job_task_rows();

  -- Idempotent backfill; rerunning preserves identical typed rows.
  INSERT INTO agent_job_tasks
    (job_id, task_index, task_status, thread_id, agent_id, label, visibility,
     started_at_ms, finished_at_ms, returned_at_ms, wake_at_ms, dismissed,
     summary, wait_reason, stopped_by, stop_reason)
  SELECT j.job_id, (entry.ordinality - 1)::integer,
    COALESCE(entry.task->>'status', 'queued'), entry.task->>'threadId',
    entry.task->>'agentId', entry.task->>'label', entry.task->>'visibility',
    NULLIF(entry.task->>'startedAt', '')::bigint,
    NULLIF(entry.task->>'finishedAt', '')::bigint,
    NULLIF(entry.task->>'returnedAt', '')::bigint,
    NULLIF(entry.task->>'wakeAt', '')::bigint,
    COALESCE((entry.task->>'dismissed')::boolean, FALSE), entry.task->>'summary',
    entry.task->>'waitReason', entry.task->'stoppedBy', entry.task->>'stopReason'
  FROM agent_jobs j CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.tasks, '[]'::jsonb)) WITH ORDINALITY AS entry(task, ordinality)
  ON CONFLICT (job_id, task_index) DO UPDATE SET
    task_status = EXCLUDED.task_status, thread_id = EXCLUDED.thread_id, agent_id = EXCLUDED.agent_id,
    label = EXCLUDED.label, visibility = EXCLUDED.visibility, started_at_ms = EXCLUDED.started_at_ms,
    finished_at_ms = EXCLUDED.finished_at_ms, returned_at_ms = EXCLUDED.returned_at_ms,
    wake_at_ms = EXCLUDED.wake_at_ms, dismissed = EXCLUDED.dismissed, summary = EXCLUDED.summary,
    wait_reason = EXCLUDED.wait_reason, stopped_by = EXCLUDED.stopped_by, stop_reason = EXCLUDED.stop_reason;
`;

export const down = `
  DROP TRIGGER IF EXISTS trg_sync_agent_job_task_rows ON agent_jobs;
  DROP FUNCTION IF EXISTS sync_agent_job_task_rows();
  DROP INDEX IF EXISTS idx_agent_jobs_projection_created;
  DROP INDEX IF EXISTS idx_agent_jobs_projection_finished;
  DROP INDEX IF EXISTS idx_agent_jobs_projection_active;
  DROP INDEX IF EXISTS idx_agent_job_tasks_status;
  DROP INDEX IF EXISTS idx_agent_job_tasks_thread;
  DROP TABLE IF EXISTS agent_job_tasks;
`;
