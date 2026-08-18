// Task-level actor attribution for Projects activity feed.
//
// Tool-driven task creates/moves now persist the acting source so lifecycle
// rows can render the same "who did it" field as comments. Schema-only.

export const up = `
  ALTER TABLE work_tasks
    ADD COLUMN IF NOT EXISTS created_by TEXT;

  ALTER TABLE work_tasks
    ADD COLUMN IF NOT EXISTS last_moved_by TEXT;
`;

export const down = `
  ALTER TABLE work_tasks
    DROP COLUMN IF EXISTS last_moved_by;

  ALTER TABLE work_tasks
    DROP COLUMN IF EXISTS created_by;
`;
