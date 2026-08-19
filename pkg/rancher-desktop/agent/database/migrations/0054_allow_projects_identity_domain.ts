/**
 * Migration 0054 — Allow the `projects` identity-observation domain.
 *
 * The `projects` domain records durable, observed facts about the internal
 * projects and the project-management system (goals, structure, priorities,
 * decisions, processes, relationships, blockers) — distinct from the structured
 * Projects work-state store that holds live task/epic status. Widen the domain
 * CHECK to include it. NOT VALID so startup never blocks on historical rows.
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
      CHECK (domain IN ('human', 'business', 'world', 'agent', 'environment', 'projects'))
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
      CHECK (domain IN ('human', 'business', 'world', 'agent', 'environment'))
      NOT VALID;
  END $$;
`;
