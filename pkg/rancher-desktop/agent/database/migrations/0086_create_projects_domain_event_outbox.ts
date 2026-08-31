/** Durable, generation-scoped Projects domain-event outbox (dHAe Phase 4). */
export const up = `
  CREATE TABLE IF NOT EXISTS work_project_domain_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_tasks(id),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    generation_hash TEXT,
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processing', 'completed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner TEXT,
    leased_until TIMESTAMPTZ,
    last_error TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CONSTRAINT work_project_domain_events_lease_pair CHECK (
      (lease_owner IS NULL AND leased_until IS NULL)
      OR (lease_owner IS NOT NULL AND leased_until IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_work_project_domain_events_pending
    ON work_project_domain_events (available_at, created_at)
    WHERE status = 'pending';

  CREATE INDEX IF NOT EXISTS idx_work_project_domain_events_expired
    ON work_project_domain_events (leased_until)
    WHERE status = 'processing';

  CREATE INDEX IF NOT EXISTS idx_work_project_domain_events_generation
    ON work_project_domain_events (task_id, generation, event_type);
`;

export const down = `
  DROP TABLE IF EXISTS work_project_domain_events;
`;
