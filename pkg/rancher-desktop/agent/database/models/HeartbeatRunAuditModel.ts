import { postgresClient } from '../PostgresClient';

export interface HeartbeatRunAuditInput {
  runId:                         string;
  startedAt:                     Date;
  completedAt?:                  Date | null;
  durationMs?:                   number | null;
  eventType:                     'started' | 'completed' | 'error' | 'aborted';
  status?:                       string | null;
  statusNote?:                   string | null;
  blockerReason?:                string | null;
  error?:                        string | null;
  cycleCount?:                   number | null;
  selectedProjectId?:            string | null;
  selectedEpicId?:               string | null;
  selectedTaskId?:               string | null;
  selectedTaskStatus?:           string | null;
  selectedTaskAssignee?:         string | null;
  selectedTaskLastMovedAt?:      string | null;
  selectedTaskCommentCount?:     number | null;
}

export class HeartbeatRunAuditModel {
  private static tableReady = false;

  static async ensureTable(): Promise<void> {
    if (HeartbeatRunAuditModel.tableReady) return;

    await postgresClient.query(`
      CREATE TABLE IF NOT EXISTS heartbeat_run_audit (
        run_id                       TEXT        PRIMARY KEY,
        started_at                   TIMESTAMPTZ NOT NULL,
        completed_at                 TIMESTAMPTZ,
        duration_ms                  INTEGER,
        event_type                   TEXT        NOT NULL DEFAULT 'started',
        status                       TEXT,
        status_note                  TEXT,
        blocker_reason               TEXT,
        error                        TEXT,
        cycle_count                  INTEGER,
        selected_project_id          TEXT,
        selected_epic_id             TEXT,
        selected_task_id             TEXT,
        selected_task_status         TEXT,
        selected_task_assignee       TEXT,
        selected_task_last_moved_at  TIMESTAMPTZ,
        selected_task_comment_count  INTEGER,
        created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await postgresClient.query(`
      CREATE INDEX IF NOT EXISTS idx_heartbeat_run_audit_started_at
        ON heartbeat_run_audit (started_at DESC)
    `);
    await postgresClient.query(`
      CREATE INDEX IF NOT EXISTS idx_heartbeat_run_audit_task
        ON heartbeat_run_audit (selected_task_id, started_at DESC)
    `);
    await postgresClient.query(`
      CREATE INDEX IF NOT EXISTS idx_heartbeat_run_audit_event_type
        ON heartbeat_run_audit (event_type, started_at DESC)
    `);

    HeartbeatRunAuditModel.tableReady = true;
  }

  static async record(input: HeartbeatRunAuditInput): Promise<void> {
    try {
      await HeartbeatRunAuditModel.ensureTable();
      await postgresClient.query(
        `INSERT INTO heartbeat_run_audit (
           run_id, started_at, completed_at, duration_ms, event_type,
           status, status_note, blocker_reason, error, cycle_count,
           selected_project_id, selected_epic_id, selected_task_id,
           selected_task_status, selected_task_assignee,
           selected_task_last_moved_at, selected_task_comment_count
         )
         VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12, $13,
           $14, $15,
           $16, $17
         )
         ON CONFLICT (run_id) DO UPDATE SET
           completed_at = EXCLUDED.completed_at,
           duration_ms = EXCLUDED.duration_ms,
           event_type = EXCLUDED.event_type,
           status = EXCLUDED.status,
           status_note = EXCLUDED.status_note,
           blocker_reason = EXCLUDED.blocker_reason,
           error = EXCLUDED.error,
           cycle_count = EXCLUDED.cycle_count,
           selected_project_id = EXCLUDED.selected_project_id,
           selected_epic_id = EXCLUDED.selected_epic_id,
           selected_task_id = EXCLUDED.selected_task_id,
           selected_task_status = EXCLUDED.selected_task_status,
           selected_task_assignee = EXCLUDED.selected_task_assignee,
           selected_task_last_moved_at = EXCLUDED.selected_task_last_moved_at,
           selected_task_comment_count = EXCLUDED.selected_task_comment_count,
           updated_at = NOW()`,
        [
          input.runId,
          input.startedAt,
          input.completedAt ?? null,
          input.durationMs ?? null,
          input.eventType,
          input.status ?? null,
          input.statusNote ?? null,
          input.blockerReason ?? null,
          input.error ?? null,
          input.cycleCount ?? null,
          input.selectedProjectId ?? null,
          input.selectedEpicId ?? null,
          input.selectedTaskId ?? null,
          input.selectedTaskStatus ?? null,
          input.selectedTaskAssignee ?? null,
          input.selectedTaskLastMovedAt ?? null,
          input.selectedTaskCommentCount ?? null,
        ],
      );
    } catch (err) {
      console.warn('[HeartbeatRunAuditModel] Failed to record heartbeat run:', err);
    }
  }
}
