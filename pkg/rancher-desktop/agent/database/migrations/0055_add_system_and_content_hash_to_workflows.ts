/**
 * Migration 0055 — Mark workflows as locked "core" routines.
 *
 * Core routines (e.g. the per-domain nightly "dreaming" consolidation routines)
 * ship baked into Sulla Desktop and are re-asserted from a bundled definition on
 * every boot. They are visible and runnable, and may be DISABLED by the human,
 * but they cannot be edited or deleted through any user-facing surface.
 *
 *   - `system`        marks a row as a locked core routine. The edit/delete
 *                     guards in WorkflowModel + the import/status tools refuse
 *                     to mutate a row where system = true (the boot seeder is
 *                     the only writer, via an internal actor flag). The `enabled`
 *                     flag stays user-writable so a core routine can be paused.
 *   - `content_hash`  sha-256 of the seeded routine definition + its notes only
 *                     (not sibling files). The seeder recomputes it each boot; a
 *                     mismatch means the live definition drifted from the bundle,
 *                     and the seeder silently re-seeds from the bundle.
 *
 * Both default to the non-core case so every existing row is untouched.
 */

export const up = `
  ALTER TABLE workflows
    ADD COLUMN IF NOT EXISTS system       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS content_hash TEXT    NULL;

  CREATE INDEX IF NOT EXISTS idx_workflows_system ON workflows(system);
`;

export const down = `
  DROP INDEX IF EXISTS idx_workflows_system;
  ALTER TABLE workflows
    DROP COLUMN IF EXISTS content_hash,
    DROP COLUMN IF EXISTS system;
`;
