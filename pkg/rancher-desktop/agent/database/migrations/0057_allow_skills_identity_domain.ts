/**
 * Migration 0057 — Allow the `skills` identity-observation domain.
 *
 * The `skills` domain records durable facts about actual skill ARTIFACTS
 * (SKILL.md files) — where a named skill was found (marketplace, locally
 * installed under ~/sulla/skills/, or discovered elsewhere), and whether a
 * run of a named skill succeeded or failed. Widen the domain CHECK to
 * include it. NOT VALID so startup never blocks on historical rows.
 */

export const up = `
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'identity_observations_domain_check'
        AND conrelid = 'identity_observations'::regclass
    ) THEN
      ALTER TABLE identity_observations DROP CONSTRAINT identity_observations_domain_check;
    END IF;

    ALTER TABLE identity_observations
      ADD CONSTRAINT identity_observations_domain_check
      CHECK (domain IN ('human', 'business', 'world', 'agent', 'environment', 'projects', 'skills'))
      NOT VALID;
  END $$;
`;

export const down = `
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'identity_observations_domain_check'
        AND conrelid = 'identity_observations'::regclass
    ) THEN
      ALTER TABLE identity_observations DROP CONSTRAINT identity_observations_domain_check;
    END IF;

    ALTER TABLE identity_observations
      ADD CONSTRAINT identity_observations_domain_check
      CHECK (domain IN ('human', 'business', 'world', 'agent', 'environment', 'projects'))
      NOT VALID;
  END $$;
`;
