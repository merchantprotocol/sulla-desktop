/**
 * Migration 0097 — Trigram GIN index on identity_observations.content.
 *
 * Pre-turn identity recall now runs as an SQL fast path (IDF-weighted
 * `content ILIKE '%term%'` scoring) instead of one blocking LLM agent per
 * domain, and the writer's duplicate gate uses pg_trgm similarity(). Both
 * are index-assisted with gin_trgm_ops. Same approach as 0041 for
 * observations.content. Schema-only — no user data.
 */

export const up = `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE INDEX IF NOT EXISTS idx_identity_observations_content_trgm
    ON identity_observations USING gin (content gin_trgm_ops);
`;

export const down = `DROP INDEX IF EXISTS idx_identity_observations_content_trgm;`;
