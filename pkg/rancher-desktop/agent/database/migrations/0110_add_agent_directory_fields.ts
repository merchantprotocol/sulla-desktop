/** Agent directory cards + built-in agent tracking.
 *
 * Directory cards let any agent pick the right specialist from the
 * agent_definitions table: when to call it, when not to, what to send, what
 * comes back, a rough cost tier, and which agents it may call in turn.
 *
 * is_builtin / builtin_hash mark rows seeded from the bundled catalog
 * (agent/builtinAgents). builtin_hash is the hash of the managed content the
 * seeder last wrote; a row whose live content no longer matches it has been
 * edited by a human and is never overwritten.
 *
 * agent_builtin_seed_ledger remembers which bundled slugs this install has
 * already had, so a built-in agent the human deletes is not re-created.
 *
 * Additive only: every new column has a default and no existing row changes.
 */
export const up = `
  ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS when_to_call     TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS when_not_to_call TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS send             TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS returns          TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS cost_tier        TEXT
      CHECK (cost_tier IS NULL OR cost_tier IN ('low', 'medium', 'high')),
    ADD COLUMN IF NOT EXISTS can_call         TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS is_builtin       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS builtin_hash     TEXT;

  CREATE TABLE IF NOT EXISTS agent_builtin_seed_ledger (
    slug            TEXT PRIMARY KEY,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

export const down = `
  DROP TABLE IF EXISTS agent_builtin_seed_ledger;
  ALTER TABLE agent_definitions
    DROP COLUMN IF EXISTS builtin_hash,
    DROP COLUMN IF EXISTS is_builtin,
    DROP COLUMN IF EXISTS can_call,
    DROP COLUMN IF EXISTS cost_tier,
    DROP COLUMN IF EXISTS returns,
    DROP COLUMN IF EXISTS send,
    DROP COLUMN IF EXISTS when_not_to_call,
    DROP COLUMN IF EXISTS when_to_call;
`;
