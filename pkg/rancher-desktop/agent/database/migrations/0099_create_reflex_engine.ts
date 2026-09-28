export const up = `
CREATE TABLE IF NOT EXISTS reflex_examples (
  id         TEXT PRIMARY KEY,
  utterance  TEXT NOT NULL,
  tool_name  TEXT NOT NULL,
  params     JSONB NOT NULL DEFAULT '{}'::jsonb,
  positive   BOOLEAN NOT NULL DEFAULT TRUE,
  source     TEXT NOT NULL DEFAULT 'model',
  thread_id  TEXT,
  archived   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS reflex_examples_active_unique
  ON reflex_examples (lower(utterance), tool_name, md5(params::text), positive)
  WHERE NOT archived;
CREATE INDEX IF NOT EXISTS reflex_examples_tool ON reflex_examples (tool_name) WHERE NOT archived;

CREATE TABLE IF NOT EXISTS reflex_decisions (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT,
  utterance   TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence  DOUBLE PRECISION NOT NULL,
  status      TEXT NOT NULL,
  result      TEXT,
  corrected   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reflex_decisions_thread ON reflex_decisions (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reflex_decisions_status ON reflex_decisions (status, created_at DESC);
`;
export const down = `DROP TABLE IF EXISTS reflex_decisions; DROP TABLE IF EXISTS reflex_examples;`;
