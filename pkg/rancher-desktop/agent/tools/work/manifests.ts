import type { ToolManifest } from '../registry';

/**
 * Work-item tools — the operator agenda in Postgres.
 *
 * Hierarchy: work_projects → work_epics → work_tasks (optional parent_id
 * for subtasks) + work_task_comments. Distinct from the filesystem
 * `projects` category (PROJECT.md PRDs). Soft-archive only.
 */
export const workItemsToolManifests: ToolManifest[] = [
  {
    name:        'list_work_items',
    description: 'List the operator workboard from Postgres: projects, epics, and/or tasks. Filter by kind, status, priority, project, epic, parent task, or assignee. Default kind=task shows open work ordered by priority then due date then last_moved_at. This is the structured agenda — not the filesystem PROJECT.md PRDs.',
    category:    'work',
    schemaDef:   {
      kind:         { type: 'string', optional: true, description: 'What to list: "project", "epic", "task", or "all" (default "task").' },
      status:       { type: 'string', optional: true, description: 'Filter by status (e.g. working, should, want, gated, done, cancelled). Omit for all non-archived.' },
      priority:     { type: 'string', optional: true, description: 'Filter by priority: p0, p1, p2, p3, p4.' },
      project_id:   { type: 'string', optional: true, description: 'Limit to one project id (applies to epics + tasks).' },
      epic_id:      { type: 'string', optional: true, description: 'Limit to one epic id (tasks only).' },
      parent_id:    { type: 'string', optional: true, description: 'Limit to subtasks of this task id.' },
      assignee:     { type: 'string', optional: true, description: 'Filter tasks by assignee (e.g. heartbeat, sulla-ea, jonathon).' },
      include_done: { type: 'boolean', optional: true, description: 'When true, include done/cancelled rows. Default false.' },
      limit:        { type: 'number', optional: true, description: 'Max rows per kind (default 50).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_work_items'),
  },
  {
    name:        'get_work_item',
    description: 'Fetch one work item by id. Auto-detects project / epic / task. For a project, also returns its epics. For an epic, also returns its tasks. For a task, also returns comments (GitHub-issue style notes) and any subtasks.',
    category:    'work',
    schemaDef:   {
      id:   { type: 'string', description: 'Work-item id (tiny id from list_work_items / upsert_*).' },
      kind: { type: 'string', optional: true, description: 'Optional hint: "project", "epic", or "task". Omit to search all three.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_work_item'),
  },
  {
    name:        'search_work_items',
    description: 'Keyword search across project / epic / task titles and descriptions. Split into words; any-word ILIKE match, ranked by phrase hit then word-count then recency. Use before creating a new item to avoid duplicates, or to find work related to the current turn.',
    category:    'work',
    schemaDef:   {
      query:            { type: 'string', description: 'Search keyword or phrase.' },
      kind:             { type: 'string', optional: true, description: 'Limit to "project", "epic", or "task". Omit to search all three.' },
      limit:            { type: 'number', optional: true, description: 'Max results (default 20).' },
      include_archived: { type: 'boolean', optional: true, description: 'When true, also search archived rows. Default false.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./search_work_items'),
  },
  {
    name:        'upsert_project',
    description: 'Create or update a work project (the top of the operator agenda: description, status, priority, due date). Pass id to update in place; otherwise a matching slug is updated instead of creating a duplicate. Distinct from create_project, which writes a filesystem PROJECT.md PRD.',
    category:    'work',
    schemaDef:   {
      id:          { type: 'string', optional: true, description: 'Existing project id to update in place.' },
      slug:        { type: 'string', optional: true, description: 'Stable slug (e.g. operator-transition). Auto-derived from title when omitted.' },
      title:       { type: 'string', optional: true, description: 'Short project name. Required when creating.' },
      description: { type: 'string', optional: true, description: 'What this project is and what done looks like.' },
      status:      { type: 'string', optional: true, description: 'working | should | want | might | gated | done | cancelled. Default working.' },
      priority:    { type: 'string', optional: true, description: 'p0 | p1 | p2 | p3 | p4. Default p2.' },
      owner:       { type: 'string', optional: true, description: 'Who owns the project (e.g. heartbeat, sulla-ea, jonathon).' },
      due_at:      { type: 'string', optional: true, description: 'ISO due date, or empty string to clear.' },
      source:      { type: 'string', optional: true, description: 'Optional source label (defaults to "agent").' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./upsert_project'),
  },
  {
    name:        'upsert_epic',
    description: 'Create or update an epic under a work project. Epics are the major chunks of a project (their own description, status, priority, due date). Pass id to update; otherwise a matching (project_id, slug) is updated.',
    category:    'work',
    schemaDef:   {
      id:          { type: 'string', optional: true, description: 'Existing epic id to update in place.' },
      project_id:  { type: 'string', optional: true, description: 'Parent project id. Required when creating.' },
      slug:        { type: 'string', optional: true, description: 'Stable slug inside the project. Auto-derived from title when omitted.' },
      title:       { type: 'string', optional: true, description: 'Short epic name. Required when creating.' },
      description: { type: 'string', optional: true, description: 'What this epic delivers.' },
      status:      { type: 'string', optional: true, description: 'working | should | want | might | gated | done | cancelled. Default working.' },
      priority:    { type: 'string', optional: true, description: 'p0 | p1 | p2 | p3 | p4. Default p2.' },
      position:    { type: 'number', optional: true, description: 'Manual sort order inside the project (default 0).' },
      due_at:      { type: 'string', optional: true, description: 'ISO due date, or empty string to clear.' },
      source:      { type: 'string', optional: true, description: 'Optional source label (defaults to "agent").' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./upsert_epic'),
  },
  {
    name:        'upsert_task',
    description: 'Create or update a task (GitHub-issue shaped: title, description, status, priority, due date, assignee, labels, optional github_issue). Pass parent_id to nest a subtask under another task. Pass id to update in place. Moving status/priority/assignee/due_at/parent_id/epic_id stamps last_moved_at so the board can show what actually moved.',
    category:    'work',
    schemaDef:   {
      id:            { type: 'string', optional: true, description: 'Existing task id to update in place.' },
      epic_id:       { type: 'string', optional: true, description: 'Parent epic id. Required when creating a top-level task.' },
      parent_id:     { type: 'string', optional: true, description: 'Parent task id when this is a subtask. Empty string clears it.' },
      title:         { type: 'string', optional: true, description: 'Task title. Required when creating.' },
      description:   { type: 'string', optional: true, description: 'Issue-style body — what done looks like.' },
      status:        { type: 'string', optional: true, description: 'working | should | want | might | gated | done | cancelled. Default working.' },
      priority:      { type: 'string', optional: true, description: 'p0 | p1 | p2 | p3 | p4. Default p2.' },
      assignee:      { type: 'string', optional: true, description: 'Who is carrying it (heartbeat, sulla-ea, jonathon, or empty to unassign).' },
      due_at:        { type: 'string', optional: true, description: 'ISO due date, or empty string to clear.' },
      labels:        { type: 'array', optional: true, description: 'String labels (e.g. ["gate","operator"]). Replaces the full set when provided.' },
      github_issue:  { type: 'string', optional: true, description: 'Optional owner/repo#n or URL mapping to a GitHub issue.' },
      position:      { type: 'number', optional: true, description: 'Manual sort order inside the epic (default 0).' },
      source:        { type: 'string', optional: true, description: 'Optional source label (defaults to "agent").' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./upsert_task'),
  },
  {
    name:        'add_task_comment',
    description: 'Add a note/comment on a task (GitHub-issue style). Comments are append-only history — they are never edited or hard-deleted. Use this for progress notes, blockers, and decisions; use upsert_task to change status/priority/due date.',
    category:    'work',
    schemaDef:   {
      task_id: { type: 'string', description: 'Task id to comment on.' },
      body:    { type: 'string', description: 'Comment markdown/text.' },
      author:  { type: 'string', optional: true, description: 'Who wrote it (defaults to "agent").' },
    },
    operationTypes: ['create'],
    loader:         () => import('./add_task_comment'),
  },
  {
    name:        'archive_work_item',
    description: 'Soft-archive a project, epic, or task by id. Never hard-deleted. Archiving a project also archives its epics + tasks; archiving an epic also archives its tasks. History stays recoverable via get_work_item / search with include_archived.',
    category:    'work',
    schemaDef:   {
      id:   { type: 'string', description: 'Work-item id to archive.' },
      kind: { type: 'string', optional: true, description: 'Optional hint: "project", "epic", or "task". Omit to search all three.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./archive_work_item'),
  },
];
