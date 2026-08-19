/**
 * Migration 0053 — Allow the `environment` identity-observation domain.
 *
 * 0051 constrained identity_observations.domain to human/business/world/agent.
 * The `environment` domain records directly-observed, CONFIRMED facts about the
 * Sulla Desktop environment + the host machine, plus procedural lessons (what
 * worked / what failed, repeatable processes) that seed environment-specific
 * skills. Widen the CHECK to include it. NOT VALID so startup never blocks on
 * historical rows.
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
      CHECK (domain IN ('human', 'business', 'world', 'agent', 'environment'))
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
      CHECK (domain IN ('human', 'business', 'world', 'agent'))
      NOT VALID;
  END $$;
`;
