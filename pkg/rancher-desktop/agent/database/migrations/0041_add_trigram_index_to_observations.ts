/**
 * Migration 0041 — Trigram GIN index on observations.content.
 *
 * Observation recall (and the writer's dedup search) hits the table with
 * `content ILIKE '%word%'`. Without a trigram index those substring matches
 * are sequential scans — fine at a few hundred rows, but they degrade to
 * 50-200ms+ as the table grows past ~10k observations.
 *
 * A GIN index using the pg_trgm `gin_trgm_ops` operator class makes ILIKE
 * (and case-insensitive substring search generally) index-assisted, keeping
 * the SQL fast-path fast at any table size. Schema-only — no user data (nAYP).
 */

export const up = `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE INDEX IF NOT EXISTS idx_observations_content_trgm
    ON observations USING gin (content gin_trgm_ops);
`;

export const down = `DROP INDEX IF EXISTS idx_observations_content_trgm;`;
