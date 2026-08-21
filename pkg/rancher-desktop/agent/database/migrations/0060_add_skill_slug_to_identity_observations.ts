/**
 * Migration 0060 — Add `skill_slug` to identity_observations.
 *
 * The skills domain (0059) originally enforced "must name the skill" via a
 * content regex only (content must contain "Skill '<slug>' ..."). That is
 * enforceable but not queryable — you cannot ask "every row about skill
 * 'pdf-fill'" without parsing prose. Adds a real column so skills-domain
 * writes carry a structured slug alongside the prose requirement (defense in
 * depth: the column proves a row is about a specific skill, the content
 * regex proves the row's own text actually names it).
 */

export const up = `
  ALTER TABLE identity_observations
    ADD COLUMN IF NOT EXISTS skill_slug TEXT;

  CREATE INDEX IF NOT EXISTS idx_identity_obs_skill_slug
    ON identity_observations (skill_slug)
    WHERE skill_slug IS NOT NULL;
`;

export const down = `
  DROP INDEX IF EXISTS idx_identity_obs_skill_slug;
  ALTER TABLE identity_observations DROP COLUMN IF EXISTS skill_slug;
`;
