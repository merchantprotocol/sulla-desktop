/**
 * Make containers the database default for agent definitions created after
 * this migration. Deliberately do not update existing rows: run_location is
 * already the persisted user choice, including explicit VM selections.
 */
export const up = `
  ALTER TABLE agent_definitions
    ALTER COLUMN run_location SET DEFAULT 'container';
`;

export const down = `
  ALTER TABLE agent_definitions
    ALTER COLUMN run_location SET DEFAULT 'vm';
`;
