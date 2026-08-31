/**
 * work_routine_slots — atomic reservation ledger for protected Projects
 * routine concurrency. One row = one running protected routine holding a slot
 * of its kind. RoutineConcurrencyPolicy acquires/releases rows under a
 * transaction-scoped advisory lock so per-kind ceilings are race-free, and
 * reclaims rows whose owner crashed without releasing (heartbeat_at ages out).
 */
export const up = `
CREATE TABLE IF NOT EXISTS work_routine_slots (
  id           TEXT        PRIMARY KEY,
  kind         TEXT        NOT NULL,
  owner        TEXT,
  task_id      TEXT,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_routine_slots_kind
  ON work_routine_slots (kind);

CREATE INDEX IF NOT EXISTS idx_work_routine_slots_reclaim
  ON work_routine_slots (heartbeat_at ASC);
`;

export const down = `DROP TABLE IF EXISTS work_routine_slots CASCADE;`;
