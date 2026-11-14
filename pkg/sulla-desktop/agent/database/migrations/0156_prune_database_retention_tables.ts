// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Bound historical subject-memory and workflow checkpoint storage. */
export const up = `
  CREATE INDEX IF NOT EXISTS idx_subject_memory_sent_thread_sent_at
    ON subject_memory.sent (thread_id, sent_at DESC);
  CREATE INDEX IF NOT EXISTS idx_subject_memory_sent_sent_at
    ON subject_memory.sent (sent_at);
  CREATE INDEX IF NOT EXISTS idx_subject_memory_sent_cleared
    ON subject_memory.sent (sent_at) WHERE cleared = true;

  DO $$
  DECLARE deleted_count INTEGER;
  BEGIN
    LOOP
      WITH batch AS (
        SELECT sent.ctid
          FROM subject_memory.sent AS sent
         WHERE sent.cleared OR (
           sent.sent_at < NOW() - INTERVAL '14 days'
           AND NOT EXISTS (
             SELECT 1 FROM subject_memory.sent AS active
              WHERE active.thread_id = sent.thread_id
                AND active.sent_at >= NOW() - INTERVAL '14 days'
           )
         )
         ORDER BY sent.sent_at
         LIMIT 1000
      )
      DELETE FROM subject_memory.sent AS sent USING batch WHERE sent.ctid = batch.ctid;
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      EXIT WHEN deleted_count = 0;
    END LOOP;

    LOOP
      WITH batch AS (
        SELECT checkpoint.id
          FROM workflow_checkpoints AS checkpoint
          JOIN workflow_executions AS execution USING (execution_id)
         WHERE execution.status IN ('completed', 'failed')
           AND COALESCE(execution.completed_at, execution.terminal_at, execution.updated_at)
               < NOW() - INTERVAL '14 days'
         ORDER BY checkpoint.id
         LIMIT 500
      )
      DELETE FROM workflow_checkpoints AS checkpoint USING batch WHERE checkpoint.id = batch.id;
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      EXIT WHEN deleted_count = 0;
    END LOOP;
  END $$;

  -- The retired project service has no runtime readers or writers. Remove its
  -- legacy comments and the optional historical FK from artifact receipts.
  DROP TABLE IF EXISTS work_task_comments CASCADE;
`;

export const down = `
  CREATE TABLE IF NOT EXISTS work_task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks(id),
    body TEXT NOT NULL,
    author TEXT,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_work_task_comments_task
    ON work_task_comments (task_id, archived, created_at ASC);
  DO $$ BEGIN
    IF to_regclass('work_artifact_receipts') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'work_artifact_receipts_comment_id_fkey'
    ) THEN
      ALTER TABLE work_artifact_receipts ADD CONSTRAINT work_artifact_receipts_comment_id_fkey
        FOREIGN KEY (comment_id) REFERENCES work_task_comments(id) ON DELETE SET NULL;
    END IF;
  END $$;
  DROP INDEX IF EXISTS idx_subject_memory_sent_thread_sent_at;
  DROP INDEX IF EXISTS idx_subject_memory_sent_sent_at;
  DROP INDEX IF EXISTS idx_subject_memory_sent_cleared;
`;
