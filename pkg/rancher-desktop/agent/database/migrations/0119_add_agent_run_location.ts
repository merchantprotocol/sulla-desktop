export const up = `
  ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS run_location TEXT NOT NULL DEFAULT 'vm'
      CHECK (run_location IN ('vm', 'container'));
`;

export const down = `
  ALTER TABLE agent_definitions DROP COLUMN IF EXISTS run_location;
`;
