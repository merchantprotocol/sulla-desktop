/**
 * Migration 0050 — Create identity_observations table.
 *
 * The focused, domain-keyed observation subsystem (docs/user-observation-subsystem-PRD.md).
 * Clones the proven `observations` pattern but replaces free-form priority with
 * a certainty LEVEL and adds a DOMAIN mirroring ~/sulla/identity/
 * (human / business / world / agent — human ships first).
 *
 * Levels (certainty, not priority):
 *   3 — stated fact: the subject directly told us this
 *   2 — derived fact: established from conversation evidence, not stated outright
 *   1 — conclusion: reasoned from L3/L2 facts (personality, style, habits)
 *
 * Rows are NEVER hard-deleted — soft-archived via `archived` so the full
 * history is always recoverable (same covenant as `observations`).
 */

export const up = `
  CREATE TABLE IF NOT EXISTS identity_observations (
    id          TEXT        PRIMARY KEY,
    domain      TEXT        NOT NULL DEFAULT 'human',
    level       SMALLINT    NOT NULL DEFAULT 2 CHECK (level IN (1, 2, 3)),
    category    TEXT,
    content     TEXT        NOT NULL,
    basis       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ,
    archived    BOOLEAN     NOT NULL DEFAULT false,
    source      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_identity_obs_domain_level_created
    ON identity_observations (domain, archived, level DESC, created_at DESC);
`;

export const down = `DROP TABLE IF EXISTS identity_observations CASCADE;`;
