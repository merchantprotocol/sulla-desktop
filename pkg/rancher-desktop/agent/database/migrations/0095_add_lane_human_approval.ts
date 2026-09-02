/**
 * Migration 0095 — let each Projects lane opt into a simple human gate.
 *
 * The decision is lane configuration, not PR-head state. Advancing a task
 * leaves the recorded approval in its append-only comment history and later
 * GitHub pushes do not revoke it.
 */
export const up = `
  ALTER TABLE work_lane_definitions
    ADD COLUMN IF NOT EXISTS requires_human_approval BOOLEAN NOT NULL DEFAULT false;
`;

export const down = `
  ALTER TABLE work_lane_definitions
    DROP COLUMN IF EXISTS requires_human_approval;
`;
