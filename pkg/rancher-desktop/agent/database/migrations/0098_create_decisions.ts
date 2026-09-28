export const up = `
CREATE TABLE IF NOT EXISTS human_decisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  record JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS human_decisions_status ON human_decisions(status, updated_at);
CREATE TABLE IF NOT EXISTS tool_approval_policies (
  tool_name TEXT PRIMARY KEY,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
export const down = `DROP TABLE IF EXISTS tool_approval_policies; DROP TABLE IF EXISTS human_decisions;`;
