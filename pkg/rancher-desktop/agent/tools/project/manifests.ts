import type { ToolManifest } from '../registry';

/**
 * Project-item tools — Projects project-state in Postgres (the issue ledger
 * behind the Projects view). Full CRUD across the hierarchy:
 *
 *   work_projects → work_epics → work_tasks (optional parent_id subtasks)
 *                                 + work_task_comments
 *
 * Explicit create_* / update_* / archive per record type — no combined
 * "upsert". Distinct from the filesystem `projects` category (PROJECT.md
 * PRDs). Soft-archive only; archiving cascades down.
 *
 * Vocabulary (free-text columns, but use these consistently):
 *   status   → backlog | todo | planning | in_progress | in_review | blocked | done | cancelled | parked
 *   priority → critical | high | medium | low
 */
const ITEM_STATUS_DESC = 'working | backlog | todo | planning | in_progress | in_review | blocked | done | cancelled | parked.';
const PROJECT_STATUS_DESC = 'working | backlog | blocked | done | cancelled | parked.';
const TASK_STATUS_DESC = 'backlog | todo | planning | in_progress | in_review | blocked | done | cancelled | parked.';
const PRIORITY_DESC = 'critical | high | medium | low.';

export const projectToolManifests: ToolManifest[] = [
  // ── reads ────────────────────────────────────────────────────────────
  {
    name:        'list_project_items',
    description: 'List Projects project-state from Postgres: projects, epics, and/or tasks. Filter by kind, status, priority, project, epic, parent task, or assignee. Default kind=task shows open work. This is the structured agenda — not the filesystem PROJECT.md PRDs.',
    category:    'project',
    schemaDef:   {
      kind:         { type: 'string', optional: true, description: 'What to list: "project", "epic", "task", or "all" (default "task").' },
      status:       { type: 'string', optional: true, description: `Filter by status: ${ ITEM_STATUS_DESC } Omit for all non-archived.` },
      priority:     { type: 'string', optional: true, description: `Filter by priority: ${ PRIORITY_DESC }` },
      project_id:   { type: 'string', optional: true, description: 'Limit to one project id (applies to epics + tasks).' },
      epic_id:      { type: 'string', optional: true, description: 'Limit to one epic id (tasks only).' },
      parent_id:    { type: 'string', optional: true, description: 'Limit to subtasks of this task id.' },
      assignee:     { type: 'string', optional: true, description: 'Filter tasks by assignee (e.g. heartbeat, sulla, human).' },
      include_done: { type: 'boolean', optional: true, description: 'When true, include done/cancelled rows. Default false.' },
      limit:        { type: 'number', optional: true, description: 'Max rows per kind (default 50).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_project_items'),
  },
  {
    name:        'get_project_item',
    description: 'Fetch one project item by id. Auto-detects project / epic / task. For a project, also returns its epics. For an epic, also returns its tasks. For a task, also returns comments and any subtasks.',
    category:    'project',
    schemaDef:   {
      id:                { type: 'string', description: 'Project item id (tiny id from list_project_items / create_*).' },
      kind:              { type: 'string', optional: true, description: 'Optional hint: "project", "epic", or "task". Omit to search all three.' },
      include_knowledge: { type: 'boolean', optional: true, description: 'Append a compact direct/inherited Knowledge Base association summary.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./get_project_item'),
  },
  {
    name:        'search_project_items',
    description: 'Keyword search across project / epic / task titles and descriptions. Use before creating a new item to avoid duplicates, or to find work related to the current turn.',
    category:    'project',
    schemaDef:   {
      query:            { type: 'string', description: 'Search keyword or phrase.' },
      kind:             { type: 'string', optional: true, description: 'Limit to "project", "epic", or "task". Omit to search all three.' },
      limit:            { type: 'number', optional: true, description: 'Max results (default 20).' },
      include_archived: { type: 'boolean', optional: true, description: 'When true, also search archived rows. Default false.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./search_project_items'),
  },
  {
    name:        'list_task_comments',
    description: 'List the comment thread on a task, oldest first. Comments are append-only history (progress notes, blockers, decisions).',
    category:    'project',
    schemaDef:   {
      task_id: { type: 'string', description: 'Task id whose comments to list.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_task_comments'),
  },
  {
    name:        'project_report',
    description: 'Standup report: recent completions plus activity-rotated actionable, blocked-recovery, and planning queues with project/epic context. Optionally scope to one project or assignee. Use this for a quick "what moved and what\'s next" pulse.',
    category:    'project',
    schemaDef:   {
      hours:      { type: 'number', optional: true, description: 'Look-back window in hours for completed work (default 24).' },
      next_limit: { type: 'number', optional: true, description: 'How many upcoming tasks to list (default 15).' },
      project_id: { type: 'string', optional: true, description: 'Limit the report to one project id.' },
      assignee:   { type: 'string', optional: true, description: 'Limit to one assignee (e.g. heartbeat, sulla, human).' },
    },
    operationTypes: ['read'],
    loader:         () => import('./project_report'),
  },
  {
    name:        'list_linked_knowledge',
    description: 'List direct Knowledge Base links for a Projects item and, when requested, inherited parent links.',
    category:    'project',
    schemaDef:   {
      item_kind:         { type: 'string', description: 'project, epic, or task.' },
      item_id:           { type: 'string', description: 'Projects item id.' },
      include_inherited: { type: 'boolean', optional: true, description: 'Include parent links; default true.' },
      relation_type:     { type: 'string', optional: true, description: 'Optional relation filter.' },
      include_archived:  { type: 'boolean', optional: true, description: 'Include archived links/nodes.' },
      limit:             { type: 'number', optional: true, description: 'Bounded result limit.' },
    },
    operationTypes: ['read'],
    loader:         () => import('./list_linked_knowledge'),
  },
  {
    name:        'link_knowledge_item',
    description: 'Attach an existing Knowledge Base node to exactly one Projects item through the shared association model.',
    category:    'project',
    schemaDef:   {
      item_kind:         { type: 'string', description: 'project, epic, or task.' },
      item_id:           { type: 'string', description: 'Projects item id.' },
      knowledge_node_id: { type: 'string', description: 'Knowledge Base node id.' },
      relation_type:     { type: 'string', optional: true, description: 'Soft relation vocabulary; defaults to related_to.' },
      note:              { type: 'string', optional: true, description: 'Optional association note.' },
      actor:             { type: 'string', optional: true, description: 'Agent/user attribution.' },
      source:            { type: 'string', optional: true, description: 'Mutation source.' },
    },
    operationTypes: ['create', 'update'],
    loader:         () => import('./link_knowledge_item'),
  },
  {
    name:        'unlink_knowledge_item',
    description: 'Soft-unlink one direct Knowledge Base association from a Projects item.',
    category:    'project',
    schemaDef:   {
      item_kind:         { type: 'string', description: 'project, epic, or task.' },
      item_id:           { type: 'string', description: 'Projects item id.' },
      knowledge_node_id: { type: 'string', description: 'Knowledge Base node id.' },
      relation_type:     { type: 'string', optional: true, description: 'Relation to unlink; defaults to related_to.' },
      actor:             { type: 'string', optional: true, description: 'Agent/user attribution.' },
      source:            { type: 'string', optional: true, description: 'Mutation source.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./unlink_knowledge_item'),
  },

  // ── projects ─────────────────────────────────────────────────────────
  {
    name:        'create_project',
    description: 'Create a NEW project (top of the operator agenda). Always inserts a new row (a unique slug is resolved automatically). Use update_project to change an existing one. Distinct from the filesystem PROJECT.md PRD tooling.',
    category:    'project',
    schemaDef:   {
      title:          { type: 'string', description: 'Short project name.' },
      slug:           { type: 'string', optional: true, description: 'Stable slug (e.g. operator-transition). Auto-derived from title when omitted; suffixed if taken.' },
      description:    { type: 'string', optional: true, description: 'What this project is and what done looks like.' },
      outcome_metric: { type: 'string', optional: true, description: 'How you will know it is done.' },
      status:         { type: 'string', optional: true, description: `Status: ${ PROJECT_STATUS_DESC } Default backlog.` },
      priority:       { type: 'string', optional: true, description: `Priority: ${ PRIORITY_DESC } Default medium.` },
      owner:          { type: 'string', optional: true, description: 'Who owns the project (e.g. heartbeat, sulla, human).' },
      github_repo:    { type: 'string', optional: true, description: 'Optional owner/repo this project maps to.' },
      due_at:         { type: 'string', optional: true, description: 'ISO due date.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_project'),
  },
  {
    name:        'update_project',
    description: 'Update an existing project in place (by id). Only the fields you pass change. Status / priority / due_at changes stamp last_moved_at.',
    category:    'project',
    schemaDef:   {
      id:             { type: 'string', description: 'Project id to update.' },
      title:          { type: 'string', optional: true, description: 'New project name.' },
      slug:           { type: 'string', optional: true, description: 'New stable slug.' },
      description:    { type: 'string', optional: true, description: 'Updated description.' },
      outcome_metric: { type: 'string', optional: true, description: 'Updated outcome metric.' },
      status:         { type: 'string', optional: true, description: `Status: ${ PROJECT_STATUS_DESC }` },
      priority:       { type: 'string', optional: true, description: `Priority: ${ PRIORITY_DESC }` },
      owner:          { type: 'string', optional: true, description: 'New owner, or empty string to unassign.' },
      github_repo:    { type: 'string', optional: true, description: 'owner/repo mapping.' },
      due_at:         { type: 'string', optional: true, description: 'ISO due date, or empty string to clear.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update_project'),
  },

  // ── epics ────────────────────────────────────────────────────────────
  {
    name:        'create_epic',
    description: 'Create a NEW epic under a project (the major chunks of a project). Always inserts a new row (unique slug within the project). Use update_epic to change an existing one.',
    category:    'project',
    schemaDef:   {
      project_id:  { type: 'string', description: 'Parent project id.' },
      title:       { type: 'string', description: 'Short epic name.' },
      slug:        { type: 'string', optional: true, description: 'Stable slug inside the project. Auto-derived from title when omitted; suffixed if taken.' },
      description: { type: 'string', optional: true, description: 'What this epic delivers.' },
      status:      { type: 'string', optional: true, description: `Status: ${ PROJECT_STATUS_DESC } Default todo.` },
      priority:    { type: 'string', optional: true, description: `Priority: ${ PRIORITY_DESC } Default medium.` },
      position:    { type: 'number', optional: true, description: 'Manual sort order inside the project (default 0).' },
      due_at:      { type: 'string', optional: true, description: 'ISO due date.' },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_epic'),
  },
  {
    name:        'update_epic',
    description: 'Update an existing epic in place (by id). Only the fields you pass change. Pass project_id to move it to another project; pass position to reorder it inside the project. Status / priority / due_at / project moves stamp last_moved_at.',
    category:    'project',
    schemaDef:   {
      id:          { type: 'string', description: 'Epic id to update.' },
      project_id:  { type: 'string', optional: true, description: 'Move to another project id.' },
      title:       { type: 'string', optional: true, description: 'New epic name.' },
      slug:        { type: 'string', optional: true, description: 'New stable slug.' },
      description: { type: 'string', optional: true, description: 'Updated description.' },
      status:      { type: 'string', optional: true, description: `Status: ${ PROJECT_STATUS_DESC }` },
      priority:    { type: 'string', optional: true, description: `Priority: ${ PRIORITY_DESC }` },
      position:    { type: 'number', optional: true, description: 'Manual sort order inside the project.' },
      due_at:      { type: 'string', optional: true, description: 'ISO due date, or empty string to clear.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update_epic'),
  },

  // ── tasks ────────────────────────────────────────────────────────────
  {
    name:        'create_task',
    description: 'Create a NEW task (issue) under an epic. Always inserts a new row. Pass parent_id to nest a subtask under another task. Use update_task to change an existing one.',
    category:    'project',
    schemaDef:   {
      epic_id:      { type: 'string', description: 'Parent epic id.' },
      title:        { type: 'string', description: 'Task title.' },
      parent_id:    { type: 'string', optional: true, description: 'Parent task id when this is a subtask.' },
      description:  { type: 'string', optional: true, description: 'Issue-style body — what done looks like.' },
      status:       { type: 'string', optional: true, description: `Status: ${ TASK_STATUS_DESC } Default todo.` },
      priority:     { type: 'string', optional: true, description: `Priority: ${ PRIORITY_DESC } Default medium.` },
      assignee:     { type: 'string', optional: true, description: 'Who is carrying it (heartbeat, sulla, human).' },
      due_at:       { type: 'string', optional: true, description: 'ISO due date.' },
      labels:       { type: 'array', optional: true, description: 'String labels (e.g. ["gate","operator"]).' },
      github_issue: { type: 'string', optional: true, description: 'Optional owner/repo#n or URL mapping to a GitHub issue.' },
      position:     { type: 'number', optional: true, description: 'Manual sort order inside the epic (default 0).' },
      actor:        { type: 'string', optional: true, description: 'Acting source/agent for attribution: "heartbeat" (autonomous), "sulla" (chat), "workbench", or "human". Defaults to "sulla".' },
    },
    operationTypes: ['create'],
    loader:         () => import('./create_task'),
  },
  {
    name:        'update_task',
    description: 'Update an existing task in place (by id). Only the fields you pass change. This is also the MOVE op: pass epic_id to move it to another epic, status to change its board column, or position to reorder inside its epic. Moving status/priority/assignee/due_at/parent_id/epic_id stamps last_moved_at; done/cancelled also stamps completed_at.',
    category:    'project',
    schemaDef:   {
      id:           { type: 'string', description: 'Task id to update.' },
      epic_id:      { type: 'string', optional: true, description: 'Move to another epic id.' },
      parent_id:    { type: 'string', optional: true, description: 'Parent task id when nesting; empty string clears it.' },
      title:        { type: 'string', optional: true, description: 'New task title.' },
      description:  { type: 'string', optional: true, description: 'Updated body.' },
      status:       { type: 'string', optional: true, description: `Status: ${ TASK_STATUS_DESC }` },
      priority:     { type: 'string', optional: true, description: `Priority: ${ PRIORITY_DESC }` },
      assignee:     { type: 'string', optional: true, description: 'New assignee, or empty string to unassign.' },
      due_at:       { type: 'string', optional: true, description: 'ISO due date, or empty string to clear.' },
      labels:       { type: 'array', optional: true, description: 'String labels. Replaces the full set when provided.' },
      github_issue: { type: 'string', optional: true, description: 'owner/repo#n or URL, or empty string to clear.' },
      position:     { type: 'number', optional: true, description: 'Manual sort order inside the epic.' },
      actor:        { type: 'string', optional: true, description: 'Acting source/agent for attribution: "heartbeat" (autonomous), "sulla" (chat), "workbench", or "human". Defaults to "sulla".' },
    },
    operationTypes: ['update'],
    loader:         () => import('./update_task'),
  },

  // ── comments ─────────────────────────────────────────────────────────
  {
    name:        'add_task_comment',
    description: 'Add a note/comment on a task (GitHub-issue style). Append-only history — never edited or hard-deleted. Use for progress notes, blockers, and decisions; use update_task to change status/priority/due date. Author defaults to "sulla"; pass author="human" for the operator.',
    category:    'project',
    schemaDef:   {
      task_id: { type: 'string', description: 'Task id to comment on.' },
      body:    { type: 'string', description: 'Comment markdown/text.' },
      author:  { type: 'string', optional: true, description: 'Acting source/agent for attribution: "heartbeat" (autonomous), "sulla" (chat), "workbench", or "human". Defaults to "sulla".' },
      actor:   { type: 'string', optional: true, description: 'Alias for author. Acting source/agent for attribution: "heartbeat" (autonomous), "sulla" (chat), "workbench", or "human". Defaults to "sulla".' },
    },
    operationTypes: ['create'],
    loader:         () => import('./add_task_comment'),
  },

  // ── archive (soft-delete, cascades down) ─────────────────────────────
  {
    name:        'archive_project_item',
    description: 'Soft-archive a project, epic, or task by id. Never hard-deleted. Archiving a project also archives its epics + tasks; archiving an epic also archives its tasks. Recoverable via get_project_item / search with include_archived.',
    category:    'project',
    schemaDef:   {
      id:   { type: 'string', description: 'Project item id to archive.' },
      kind: { type: 'string', optional: true, description: 'Optional hint: "project", "epic", or "task". Omit to search all three.' },
    },
    operationTypes: ['update'],
    loader:         () => import('./archive_project_item'),
  },
];
