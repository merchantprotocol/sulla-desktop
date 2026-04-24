// Three audit / history tables introduced together for Phase 2/3 tooling:
//   applescript_audit   — every applescript_execute call (compliance + debug)
//   notifications       — every notify_user call + delivery target
//   function_runs       — every function_run invocation + outcome + duration
//
// All are append-only from the agent's perspective: tools INSERT rows,
// reader tools SELECT. Pruning is a separate concern (not yet built).
export const up = `
  CREATE TABLE IF NOT EXISTS applescript_audit (
    id              SERIAL PRIMARY KEY,
    target_app      VARCHAR(100) NOT NULL,
    action_type     VARCHAR(20)  NOT NULL CHECK (action_type IN ('read', 'write')),
    script          TEXT NOT NULL,
    success         BOOLEAN NOT NULL,
    duration_ms     INTEGER,
    response_chars  INTEGER,
    error           TEXT,
    executed_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_applescript_audit_app       ON applescript_audit(target_app);
  CREATE INDEX IF NOT EXISTS idx_applescript_audit_executed  ON applescript_audit(executed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_applescript_audit_success   ON applescript_audit(success);

  CREATE TABLE IF NOT EXISTS notifications (
    id              SERIAL PRIMARY KEY,
    title           VARCHAR(500) NOT NULL,
    message         TEXT NOT NULL,
    targets         JSONB NOT NULL DEFAULT '["desktop"]'::jsonb,
    notification_id VARCHAR(200),
    silent          BOOLEAN NOT NULL DEFAULT false,
    delivered       BOOLEAN NOT NULL DEFAULT false,
    error           TEXT,
    sent_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_sent     ON notifications(sent_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_targets  ON notifications USING GIN(targets);

  CREATE TABLE IF NOT EXISTS function_runs (
    id            SERIAL PRIMARY KEY,
    slug          VARCHAR(255) NOT NULL,
    version       VARCHAR(50),
    runtime       VARCHAR(20),
    inputs        JSONB,
    outputs       JSONB,
    success       BOOLEAN NOT NULL,
    error_stage   VARCHAR(50),
    error         TEXT,
    duration_ms   INTEGER,
    started_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at  TIMESTAMP WITH TIME ZONE
  );
  CREATE INDEX IF NOT EXISTS idx_function_runs_slug     ON function_runs(slug);
  CREATE INDEX IF NOT EXISTS idx_function_runs_started  ON function_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_function_runs_success  ON function_runs(success);
`;

export const down = `
  DROP TABLE IF EXISTS function_runs CASCADE;
  DROP TABLE IF EXISTS notifications CASCADE;
  DROP TABLE IF EXISTS applescript_audit CASCADE;
`;
