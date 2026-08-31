/** Promote protected review from dark rollout while preserving explicit overrides. */
export const up = `
  ALTER TABLE lifecycle_capabilities
    ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;

  INSERT INTO sulla_settings (property, value, "cast") VALUES
    ('taskVerifierEnabled', 'true', 'boolean'),
    ('taskVerifierOwner', 'core-routine', 'string'),
    ('taskReviewCoreRoutineEnabled', 'true', 'boolean')
  ON CONFLICT (property) DO UPDATE
    SET value = EXCLUDED.value, "cast" = EXCLUDED."cast"
    WHERE (sulla_settings.property = 'taskVerifierEnabled' AND sulla_settings.value = 'false')
       OR (sulla_settings.property = 'taskVerifierOwner' AND sulla_settings.value = 'legacy')
       OR (sulla_settings.property = 'taskReviewCoreRoutineEnabled' AND sulla_settings.value = 'false');
`;

export const down = `
  DELETE FROM sulla_settings
   WHERE (property = 'taskVerifierEnabled' AND value = 'true')
      OR (property = 'taskVerifierOwner' AND value = 'core-routine')
      OR (property = 'taskReviewCoreRoutineEnabled' AND value = 'true');
  ALTER TABLE lifecycle_capabilities DROP COLUMN IF EXISTS details;
`;
