/**
 * Capability-aware lifecycle ownership.
 *
 * The capability row is the control-plane truth; task-stage claims are the
 * data-plane mutex.  Claims deliberately have no wall-clock expiry: a healthy
 * long-running owner is not stale merely because work takes time.  Restart and
 * recovery invalidate claims by runtime instance instead.
 */

export const up = `
  CREATE TABLE IF NOT EXISTS lifecycle_capabilities (
    capability_key      TEXT        PRIMARY KEY,
    version             INTEGER     NOT NULL DEFAULT 1,
    enabled             BOOLEAN     NOT NULL DEFAULT false,
    health              TEXT        NOT NULL DEFAULT 'unavailable'
      CHECK (health IN ('healthy', 'degraded', 'unavailable')),
    active_owner        TEXT,
    runtime_instance_id TEXT,
    last_success_at     TIMESTAMPTZ,
    exception_count     INTEGER     NOT NULL DEFAULT 0,
    fallback_mode       TEXT        NOT NULL DEFAULT 'heartbeat'
      CHECK (fallback_mode IN ('heartbeat', 'manual_hold', 'keep_current')),
    fallback_active     BOOLEAN     NOT NULL DEFAULT true,
    last_error          TEXT,
    recovery_task_id    TEXT REFERENCES work_tasks(id),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS work_task_stage_claims (
    id                  TEXT        PRIMARY KEY,
    task_id             TEXT        NOT NULL REFERENCES work_tasks(id),
    capability_key      TEXT        NOT NULL REFERENCES lifecycle_capabilities(capability_key),
    stage               TEXT        NOT NULL,
    owner               TEXT        NOT NULL,
    runtime_instance_id TEXT        NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'released', 'recovered', 'cancelled')),
    claimed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at         TIMESTAMPTZ
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_work_task_stage_claims_one_live
    ON work_task_stage_claims (task_id, stage)
    WHERE status = 'active';

  CREATE INDEX IF NOT EXISTS idx_work_task_stage_claims_runtime
    ON work_task_stage_claims (capability_key, runtime_instance_id, status);

  INSERT INTO lifecycle_capabilities
    (capability_key, version, enabled, health, fallback_mode, fallback_active)
  VALUES
    ('planning-council', 1, false, 'unavailable', 'heartbeat', true),
    ('todo-execution', 1, false, 'unavailable', 'heartbeat', true),
    ('in-review-verification', 1, false, 'unavailable', 'heartbeat', true),
    ('durable-waits', 1, false, 'unavailable', 'heartbeat', true),
    ('stale-recovery', 1, false, 'unavailable', 'heartbeat', true)
  ON CONFLICT (capability_key) DO NOTHING;
`;

export const down = `
  DROP TABLE IF EXISTS work_task_stage_claims CASCADE;
  DROP TABLE IF EXISTS lifecycle_capabilities CASCADE;
`;
