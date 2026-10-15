/**
 * Every (kind, slug) the startup folder import has ever seen. Once a slug is
 * here it is never imported again, so deleting or uninstalling something in
 * Postgres can't be undone by an old ~/sulla folder or a bundled copy.
 * Rows that already exist are recorded up front for the same reason.
 */
export const up = `
  CREATE TABLE IF NOT EXISTS legacy_artifact_import_ledger (
    kind          TEXT NOT NULL,
    slug          TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, slug)
  );

  INSERT INTO legacy_artifact_import_ledger (kind, slug)
    SELECT 'function', slug FROM function_definitions
    UNION SELECT 'integration', slug FROM integration_definitions
    UNION SELECT 'recipe', slug FROM recipe_definitions
    UNION SELECT 'routine', id FROM workflows
    UNION SELECT 'skill', slug FROM skill_definitions
  ON CONFLICT (kind, slug) DO NOTHING;
`;

export const down = `
  DROP TABLE IF EXISTS legacy_artifact_import_ledger;
`;
