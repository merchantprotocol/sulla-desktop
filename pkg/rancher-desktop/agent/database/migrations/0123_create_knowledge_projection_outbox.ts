/** Durable Desktop-owned delivery ledger for Knowledge -> Projects projections. */
export const up = `
  CREATE TABLE IF NOT EXISTS knowledge_projection_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (event_type IN ('upsert', 'merge')),
    aggregate_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    reconciliation_key TEXT UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_projection_outbox_pending
    ON knowledge_projection_outbox (id)
    WHERE completed_at IS NULL;
`;

export const down = `
  DROP TABLE IF EXISTS knowledge_projection_outbox;
`;
