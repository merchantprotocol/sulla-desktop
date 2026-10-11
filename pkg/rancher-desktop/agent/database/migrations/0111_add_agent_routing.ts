/** Front-door routing flag + delegation outcome log.
 *
 * agent_definitions.front_door marks agents Reflex may route a new chat to.
 * NULL means "not set": the built-in seeder fills it from the bundled card
 * only while it is NULL, so a human's true/false is never overwritten.
 *
 * agent_delegations records every hand-off from one agent to another
 * (spawn_agent jobs and launch_agent_tab contracts): who called whom, in what
 * situation, for which Projects task (when the call carried one), and how it
 * ended. It is training data for routing; nothing reads it at runtime yet.
 *
 * Additive only: new nullable column, new table, no existing row changes.
 */
export const up = `
  ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS front_door BOOLEAN;

  CREATE TABLE IF NOT EXISTS agent_delegations (
    id                TEXT PRIMARY KEY,
    via               TEXT NOT NULL CHECK (via IN ('spawn_agent', 'agent_tab')),
    parent_agent_id   TEXT NOT NULL DEFAULT '',
    parent_thread_id  TEXT,
    child_agent_id    TEXT NOT NULL,
    child_thread_id   TEXT,
    ref_id            TEXT,
    task_id           TEXT,
    situation         TEXT NOT NULL DEFAULT '',
    brief             TEXT NOT NULL DEFAULT '',
    launched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'rejected')),
    outcome_detail    TEXT NOT NULL DEFAULT '',
    result_delivered  BOOLEAN,
    result_used       BOOLEAN
  );

  CREATE INDEX IF NOT EXISTS idx_agent_delegations_child ON agent_delegations (child_agent_id, launched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_delegations_parent ON agent_delegations (parent_agent_id, launched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_delegations_ref ON agent_delegations (ref_id);
  CREATE INDEX IF NOT EXISTS idx_agent_delegations_task ON agent_delegations (task_id) WHERE task_id IS NOT NULL;
`;

export const down = `
  DROP TABLE IF EXISTS agent_delegations;
  ALTER TABLE agent_definitions
    DROP COLUMN IF EXISTS front_door;
`;
