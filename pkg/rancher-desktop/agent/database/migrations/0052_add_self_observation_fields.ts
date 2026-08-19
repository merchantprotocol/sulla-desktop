/**
 * Migration 0052 — Add structured self-observation fields.
 *
 * The identity_observations table already supports the `agent` domain. These
 * optional fields let the self observer store the user's requested shape:
 * subject, evidence, confidence, and kind.
 */

export const up = `
  ALTER TABLE identity_observations
    ADD COLUMN IF NOT EXISTS subject TEXT,
    ADD COLUMN IF NOT EXISTS evidence TEXT,
    ADD COLUMN IF NOT EXISTS confidence REAL,
    ADD COLUMN IF NOT EXISTS kind TEXT;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'identity_observations_self_subject_check'
        AND conrelid = 'identity_observations'::regclass
    ) THEN
      ALTER TABLE identity_observations
        ADD CONSTRAINT identity_observations_self_subject_check
        CHECK (subject IS NULL OR subject IN ('agent', 'agent.user'))
        NOT VALID;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'identity_observations_self_kind_check'
        AND conrelid = 'identity_observations'::regclass
    ) THEN
      ALTER TABLE identity_observations
        ADD CONSTRAINT identity_observations_self_kind_check
        CHECK (kind IS NULL OR kind IN ('correction', 'constraint', 'method', 'commitment', 'preference'))
        NOT VALID;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'identity_observations_confidence_check'
        AND conrelid = 'identity_observations'::regclass
    ) THEN
      ALTER TABLE identity_observations
        ADD CONSTRAINT identity_observations_confidence_check
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
        NOT VALID;
    END IF;
  END $$;
`;

export const down = `
  ALTER TABLE identity_observations
    DROP CONSTRAINT IF EXISTS identity_observations_confidence_check,
    DROP CONSTRAINT IF EXISTS identity_observations_self_kind_check,
    DROP CONSTRAINT IF EXISTS identity_observations_self_subject_check,
    DROP COLUMN IF EXISTS kind,
    DROP COLUMN IF EXISTS confidence,
    DROP COLUMN IF EXISTS evidence,
    DROP COLUMN IF EXISTS subject;
`;
