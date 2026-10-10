export const up = `
  CREATE TABLE IF NOT EXISTS agent_tab_contracts (
    id                TEXT PRIMARY KEY,
    parent_thread_id  TEXT NOT NULL,
    parent_channel    TEXT NOT NULL,
    parent_agent_id   TEXT NOT NULL,
    child_thread_id   TEXT NOT NULL UNIQUE,
    child_agent_id    TEXT NOT NULL,
    title             TEXT NOT NULL,
    brief             TEXT NOT NULL,
    contract_spec     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'returned', 'cancelled')),
    result            JSONB,
    depth             INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 2),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    returned_at       TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_agent_tab_contracts_parent_status
    ON agent_tab_contracts (parent_thread_id, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_tab_contracts_child
    ON agent_tab_contracts (child_thread_id);
`;

export const down = `
  DROP TABLE IF EXISTS agent_tab_contracts;
`;
