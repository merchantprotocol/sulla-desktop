/**
 * Migration 0028 — Create observations table.
 *
 * Replaces the serialized JSON array stored under the `observationalMemory`
 * key in sulla_settings with proper relational rows. Observations are NEVER
 * hard-deleted — they are soft-archived via the `archived` flag so the full
 * history is always recoverable.
 *
 * On `up`: the table is created and any existing observations from the
 * serialized `observationalMemory` setting are imported as rows.  The old
 * key is intentionally left in place for back-compat (buildObservationalMemorySection
 * fallback reads it during the migration window).
 */

export const up = `
  CREATE TABLE IF NOT EXISTS observations (
    id          TEXT        PRIMARY KEY,
    priority    TEXT        NOT NULL DEFAULT 'medium',
    content     TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ,
    archived    BOOLEAN     NOT NULL DEFAULT false,
    source      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_observations_archived_priority_created
    ON observations (archived, priority, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_observations_archived_created
    ON observations (archived, created_at DESC);
`;

export const down = `DROP TABLE IF EXISTS observations CASCADE;`;
