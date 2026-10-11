// Project-level assigned agent: the agent slug that drives the project
// (usually the project manager agent assigning itself). Plain ownership
// metadata — nothing in the app launches or schedules work from it. Nullable,
// additive only; existing rows stay unassigned.
export const up = `
ALTER TABLE work_projects
  ADD COLUMN IF NOT EXISTS assigned_agent TEXT;
`;

export const down = `
ALTER TABLE work_projects DROP COLUMN IF EXISTS assigned_agent;
`;
