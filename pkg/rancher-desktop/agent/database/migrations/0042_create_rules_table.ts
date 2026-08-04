/**
 * Migration 0042 — Create rules table.
 *
 * Backs the user-created half of the rules system that the Security
 * Conscience subconscious agent reads each turn. GLOBAL rules live as
 * markdown files under `~/sulla/rules/global/` (seeded at bootstrap);
 * USER-created rules — the ones the human adds during a conversation
 * ("never deploy on Fridays", "always confirm before touching prod") —
 * live here as relational rows so they can be searched and toggled.
 *
 * SCHEMA-ONLY (per the no-user-data-in-migrations rule): this migration
 * creates the table and nothing else. No seed rows — global defaults are
 * written to files at runtime by bootstrapSullaHome(), and user rules are
 * added at runtime via the add_rule tool.
 *
 * Rules are NEVER hard-deleted — they are soft-archived via `archived`
 * so history is always recoverable, mirroring the observations table.
 */

export const up = `
  CREATE TABLE IF NOT EXISTS sulla_rules (
    id          TEXT        PRIMARY KEY,
    scope       TEXT        NOT NULL DEFAULT 'user',
    category    TEXT        NOT NULL DEFAULT 'security',
    title       TEXT        NOT NULL,
    content     TEXT        NOT NULL,
    severity    TEXT        NOT NULL DEFAULT 'medium',
    enabled     BOOLEAN     NOT NULL DEFAULT true,
    archived    BOOLEAN     NOT NULL DEFAULT false,
    source      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_sulla_rules_active_severity
    ON sulla_rules (archived, enabled, severity, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_sulla_rules_category
    ON sulla_rules (archived, enabled, category);
`;

export const down = `DROP TABLE IF EXISTS sulla_rules CASCADE;`;
