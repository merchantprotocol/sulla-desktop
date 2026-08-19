/**
 * Migration 0051 — Constrain identity observation domains.
 *
 * 0050 introduced a domain-keyed table intended to mirror ~/sulla/identity/
 * (human / business / world / agent). Add the database guard for installs that
 * already ran 0050 before the CHECK constraint was present. NOT VALID avoids
 * blocking startup if historical bad-domain rows exist, while still enforcing
 * the constraint for new and updated rows.
 */

export const up = `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'identity_observations_domain_check'
        AND conrelid = 'identity_observations'::regclass
    ) THEN
      ALTER TABLE identity_observations
        ADD CONSTRAINT identity_observations_domain_check
        CHECK (domain IN ('human', 'business', 'world', 'agent'))
        NOT VALID;
    END IF;
  END $$;
`;

export const down = `
  ALTER TABLE identity_observations
    DROP CONSTRAINT IF EXISTS identity_observations_domain_check;
`;
