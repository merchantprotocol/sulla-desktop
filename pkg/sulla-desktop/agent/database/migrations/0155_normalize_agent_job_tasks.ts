// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Typed ownership projection for legacy task-payload lifecycle writes.
 * `agent_job_tasks` is the sole authority for Live Agents filtering and joins;
 * the job JSON remains the compatibility payload used by pre-existing lifecycle
 * APIs. The trigger is intentionally mechanical: it atomically mirrors each
 * accepted payload write into indexed columns and computes its explicit parent
 * reference. No query or business decision expands task JSON on the hot path.
 */
export const up = `
  CREATE TABLE IF NOT EXISTS agent_job_tasks (
    job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
    task_index INTEGER NOT NULL,
    task_status TEXT NOT NULL CHECK (task_status IN ('queued', 'running', 'parked', 'lost', 'completed', 'blocked', 'error', 'stopped')),
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
    completion_status TEXT,
    PRIMARY KEY (job_id, task_index)
  );
  ALTER TABLE agent_jobs
    ADD COLUMN IF NOT EXISTS parent_job_id TEXT,
    ADD COLUMN IF NOT EXISTS parent_task_index INTEGER;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_jobs_parent_task_pair_check' AND conrelid = 'agent_jobs'::regclass) THEN
      ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_parent_task_pair_check
        CHECK ((parent_job_id IS NULL) = (parent_task_index IS NULL));
    END IF;
  END $$;
  CREATE INDEX IF NOT EXISTS idx_agent_job_tasks_thread ON agent_job_tasks(thread_id) WHERE thread_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_agent_job_tasks_status ON agent_job_tasks(task_status, job_id);
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_parent_task ON agent_jobs(parent_job_id, parent_task_index) WHERE parent_job_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_projection_active ON agent_jobs(job_id) WHERE status IN ('running', 'parked');
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_projection_finished ON agent_jobs(finished_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_jobs_projection_created ON agent_jobs(created_at DESC);

  CREATE OR REPLACE FUNCTION sync_agent_job_task_rows() RETURNS trigger AS $$
  BEGIN
    INSERT INTO agent_job_tasks
      (job_id, task_index, task_status, thread_id, agent_id, label, visibility,
       started_at_ms, finished_at_ms, returned_at_ms, wake_at_ms, dismissed,
       summary, wait_reason, stopped_by, stop_reason, completion_status)
    SELECT NEW.job_id, (entry.ordinality - 1)::integer,
      COALESCE(entry.task->>'status', 'queued'), entry.task->>'threadId',
      entry.task->>'agentId', entry.task->>'label', entry.task->>'visibility',
      NULLIF(entry.task->>'startedAt', '')::bigint,
      NULLIF(entry.task->>'finishedAt', '')::bigint,
      NULLIF(entry.task->>'returnedAt', '')::bigint,
      NULLIF(entry.task->>'wakeAt', '')::bigint,
      COALESCE((entry.task->>'dismissed')::boolean, FALSE), entry.task->>'summary',
      entry.task->>'waitReason', entry.task->'stoppedBy', entry.task->>'stopReason', entry.task->'completion'->>'status'
    FROM jsonb_array_elements(COALESCE(NEW.tasks, '[]'::jsonb)) WITH ORDINALITY AS entry(task, ordinality)
    ON CONFLICT (job_id, task_index) DO UPDATE SET
      task_status = EXCLUDED.task_status, thread_id = EXCLUDED.thread_id, agent_id = EXCLUDED.agent_id,
      label = EXCLUDED.label, visibility = EXCLUDED.visibility, started_at_ms = EXCLUDED.started_at_ms,
      finished_at_ms = EXCLUDED.finished_at_ms, returned_at_ms = EXCLUDED.returned_at_ms,
      wake_at_ms = EXCLUDED.wake_at_ms, dismissed = EXCLUDED.dismissed, summary = EXCLUDED.summary,
      wait_reason = EXCLUDED.wait_reason, stopped_by = EXCLUDED.stopped_by, stop_reason = EXCLUDED.stop_reason,
      completion_status = EXCLUDED.completion_status;
    DELETE FROM agent_job_tasks
      WHERE job_id = NEW.job_id AND task_index >= jsonb_array_length(COALESCE(NEW.tasks, '[]'::jsonb));

    -- Recompute current and dependent jobs from the typed owner table. A task's
    -- thread id is identity input; hierarchy consumers read these explicit FK-like keys.
    WITH relevant AS (
      SELECT job_id, parent_thread_id FROM agent_jobs
      WHERE job_id = NEW.job_id OR parent_job_id = NEW.job_id
        OR parent_thread_id IN (SELECT thread_id FROM agent_job_tasks WHERE job_id = NEW.job_id AND thread_id IS NOT NULL)
    ), resolved AS (
      SELECT candidate.job_id, owner.job_id AS parent_job_id, owner.task_index AS parent_task_index
      FROM relevant candidate
      LEFT JOIN LATERAL (
        SELECT task.job_id, task.task_index FROM agent_job_tasks task
        JOIN agent_jobs owner_job ON owner_job.job_id = task.job_id
        WHERE candidate.parent_thread_id IS NOT NULL AND task.thread_id = candidate.parent_thread_id
        ORDER BY owner_job.created_at ASC, task.task_index ASC LIMIT 1
      ) owner ON TRUE
    )
    UPDATE agent_jobs child SET parent_job_id = resolved.parent_job_id, parent_task_index = resolved.parent_task_index
      FROM resolved WHERE child.job_id = resolved.job_id
        AND (child.parent_job_id IS DISTINCT FROM resolved.parent_job_id
          OR child.parent_task_index IS DISTINCT FROM resolved.parent_task_index);
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_sync_agent_job_task_rows ON agent_jobs;
  CREATE TRIGGER trg_sync_agent_job_task_rows
    AFTER INSERT OR UPDATE OF tasks, parent_thread_id ON agent_jobs
    FOR EACH ROW EXECUTE FUNCTION sync_agent_job_task_rows();

  -- Idempotent backfill; rerunning preserves identical typed rows.
  INSERT INTO agent_job_tasks
    (job_id, task_index, task_status, thread_id, agent_id, label, visibility,
     started_at_ms, finished_at_ms, returned_at_ms, wake_at_ms, dismissed,
       summary, wait_reason, stopped_by, stop_reason, completion_status)
  SELECT j.job_id, (entry.ordinality - 1)::integer,
    COALESCE(entry.task->>'status', 'queued'), entry.task->>'threadId',
    entry.task->>'agentId', entry.task->>'label', entry.task->>'visibility',
    NULLIF(entry.task->>'startedAt', '')::bigint,
    NULLIF(entry.task->>'finishedAt', '')::bigint,
    NULLIF(entry.task->>'returnedAt', '')::bigint,
    NULLIF(entry.task->>'wakeAt', '')::bigint,
    COALESCE((entry.task->>'dismissed')::boolean, FALSE), entry.task->>'summary',
    entry.task->>'waitReason', entry.task->'stoppedBy', entry.task->>'stopReason', entry.task->'completion'->>'status'
  FROM agent_jobs j CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.tasks, '[]'::jsonb)) WITH ORDINALITY AS entry(task, ordinality)
  ON CONFLICT (job_id, task_index) DO UPDATE SET
    task_status = EXCLUDED.task_status, thread_id = EXCLUDED.thread_id, agent_id = EXCLUDED.agent_id,
    label = EXCLUDED.label, visibility = EXCLUDED.visibility, started_at_ms = EXCLUDED.started_at_ms,
    finished_at_ms = EXCLUDED.finished_at_ms, returned_at_ms = EXCLUDED.returned_at_ms,
    wake_at_ms = EXCLUDED.wake_at_ms, dismissed = EXCLUDED.dismissed, summary = EXCLUDED.summary,
    wait_reason = EXCLUDED.wait_reason, stopped_by = EXCLUDED.stopped_by, stop_reason = EXCLUDED.stop_reason,
    completion_status = EXCLUDED.completion_status;

  -- Resolve all parent pointers after backfill, including jobs inserted before
  -- their parent's task row existed. Tie-break exactly like AgentLineageIndex.
  WITH resolved AS (
    SELECT child.job_id, owner.job_id AS parent_job_id, owner.task_index AS parent_task_index
    FROM agent_jobs child
    LEFT JOIN LATERAL (
      SELECT task.job_id, task.task_index FROM agent_job_tasks task
      JOIN agent_jobs owner_job ON owner_job.job_id = task.job_id
      WHERE child.parent_thread_id IS NOT NULL AND task.thread_id = child.parent_thread_id
      ORDER BY owner_job.created_at ASC, task.task_index ASC LIMIT 1
    ) owner ON TRUE
  )
  UPDATE agent_jobs child SET parent_job_id = resolved.parent_job_id, parent_task_index = resolved.parent_task_index
    FROM resolved WHERE child.job_id = resolved.job_id;

  CREATE OR REPLACE FUNCTION detach_agent_job_children() RETURNS trigger AS $$
  BEGIN
    UPDATE agent_jobs SET parent_job_id = NULL, parent_task_index = NULL WHERE parent_job_id = OLD.job_id;
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_detach_agent_job_children ON agent_jobs;
  CREATE TRIGGER trg_detach_agent_job_children AFTER DELETE ON agent_jobs
    FOR EACH ROW EXECUTE FUNCTION detach_agent_job_children();
`;

export const down = `
  DROP TRIGGER IF EXISTS trg_sync_agent_job_task_rows ON agent_jobs;
  DROP TRIGGER IF EXISTS trg_detach_agent_job_children ON agent_jobs;
  DROP FUNCTION IF EXISTS sync_agent_job_task_rows();
  DROP FUNCTION IF EXISTS detach_agent_job_children();
  DROP INDEX IF EXISTS idx_agent_jobs_projection_created;
  DROP INDEX IF EXISTS idx_agent_jobs_projection_finished;
  DROP INDEX IF EXISTS idx_agent_jobs_projection_active;
  DROP INDEX IF EXISTS idx_agent_job_tasks_status;
  DROP INDEX IF EXISTS idx_agent_job_tasks_thread;
  DROP TABLE IF EXISTS agent_job_tasks;
  ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_parent_task_pair_check;
  DROP INDEX IF EXISTS idx_agent_jobs_parent_task;
  ALTER TABLE agent_jobs DROP COLUMN IF EXISTS parent_task_index;
  ALTER TABLE agent_jobs DROP COLUMN IF EXISTS parent_job_id;
`;
