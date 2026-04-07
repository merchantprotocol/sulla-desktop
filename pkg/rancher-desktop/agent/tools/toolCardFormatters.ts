/**
 * Per-tool display formatters for human-friendly tool card rendering.
 *
 * Each formatter transforms raw {toolName, args, result, status, error}
 * into a structured display object the frontend can render without
 * knowing anything about the tool's internals.
 */

export interface ToolCardDisplay {
  /** Category label shown in header, e.g. "Bash", "GitHub", "Docker" */
  label: string;
  /** Human-friendly one-line summary shown in collapsed view */
  summary: string;
  /** Optional formatted input line (like bash command) */
  input?: string;
  /** Optional formatted output line on completion */
  output?: string;
  /** Rendering hint for the output section */
  outputFormat?: 'text' | 'code' | 'url' | 'json';
}

type Args = Record<string, unknown>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function str(val: unknown): string {
  return typeof val === 'string' ? val : '';
}

function truncate(val: string, max = 80): string {
  if (val.length <= max) return val;
  return `${ val.slice(0, max) }…`;
}

function countOrList(val: unknown): string {
  if (Array.isArray(val)) return val.length === 1 ? val[0] : `${ val.length } items`;
  return str(val);
}

function extractOutput(result: unknown): string | undefined {
  if (!result) return undefined;
  const r = result as any;
  if (typeof r.responseString === 'string' && r.responseString.trim()) return r.responseString;
  if (typeof r.result === 'string' && r.result.trim()) return r.result;
  if (typeof r === 'string' && r.trim()) return r;
  return undefined;
}

// ── Per-tool formatters ──────────────────────────────────────────────────────
// Each returns a partial ToolCardDisplay. Missing fields fall back to defaults.

type Formatter = (args: Args, result?: unknown) => Partial<ToolCardDisplay>;

const formatters: Record<string, Formatter> = {

  // ── Exec / Bash / Shell ──────────────────────────────────────────────────
  exec:         execFormatter,
  exec_command: execFormatter,
  shell:        execFormatter,
  bash:         execFormatter,
  run_command:  execFormatter,

  // ── File Search ─────────────────────────────────────────────────────────
  file_search(args) {
    const query = str(args.query);
    const dirPath = str(args.dirPath) || '~';
    const shortDir = dirPath.replace(/^\/Users\/[^/]+/, '~');
    return {
      label:   'Search',
      summary: `Searching for "${ truncate(query, 60) }" in ${ shortDir }`,
    };
  },

  // ── Read File ──────────────────────────────────────────────────────────
  read_file(args) {
    const filePath = str(args.path || args.filePath);
    const shortPath = filePath.replace(/^\/Users\/[^/]+/, '~');
    const startLine = args.startLine as number | undefined;
    const endLine = args.endLine as number | undefined;
    const range = startLine ? ` (lines ${ startLine }${ endLine ? `-${ endLine }` : '+' })` : '';
    return {
      label:   'File',
      summary: `Opening ${ truncate(shortPath, 60) }${ range }`,
    };
  },

  // ── Browser Tab ──────────────────────────────────────────────────────────
  browser_tab(args) {
    const action = str(args.action);
    const url = str(args.url);
    const title = str(args.title);
    const label = title || url || str(args.assetId);
    switch (action) {
    case 'open':     return { label: 'Browser', summary: `Opening ${ truncate(url || title, 60) }`, input: url || undefined };
    case 'navigate': return { label: 'Browser', summary: `Navigating to ${ truncate(url, 60) }`, input: url || undefined };
    case 'close':    return { label: 'Browser', summary: `Closing tab${ label ? `: ${ truncate(label, 50) }` : '' }` };
    default:         return { label: 'Browser', summary: `${ action || 'Managing' } tab${ label ? `: ${ truncate(label, 50) }` : '' }` };
    }
  },

  // ── Playwright ───────────────────────────────────────────────────────────
  click_element(args) {
    return { label: 'Browser', summary: `Clicking ${ truncate(str(args.handle || args.selector), 40) }` };
  },
  set_field(args) {
    const handle = truncate(str(args.handle || args.selector), 30);
    const value = truncate(str(args.value), 30);
    return { label: 'Browser', summary: `Filling '${ handle }' → '${ value }'` };
  },
  get_page_snapshot() {
    return { label: 'Browser', summary: 'Capturing page snapshot' };
  },
  get_page_text() {
    return { label: 'Browser', summary: 'Reading page text' };
  },
  get_form_values() {
    return { label: 'Browser', summary: 'Reading form values' };
  },
  scroll_to_element(args) {
    return { label: 'Browser', summary: `Scrolling to ${ truncate(str(args.selector), 40) }` };
  },
  wait_for_element(args) {
    return { label: 'Browser', summary: `Waiting for ${ truncate(str(args.selector), 40) }` };
  },

  // ── Git ──────────────────────────────────────────────────────────────────
  git_status()   { return { label: 'Git', summary: 'Checking status' }; },
  git_commit(args) {
    return { label: 'Git', summary: `Committing: ${ truncate(str(args.message), 60) }` };
  },
  git_push(args) {
    const remote = str(args.remote) || 'origin';
    const branch = str(args.branch);
    return { label: 'Git', summary: `Pushing to ${ remote }${ branch ? `/${ branch }` : '' }` };
  },
  git_pull(args) {
    const remote = str(args.remote) || 'origin';
    const branch = str(args.branch);
    return { label: 'Git', summary: `Pulling from ${ remote }${ branch ? `/${ branch }` : '' }` };
  },
  git_diff(args) {
    const file = str(args.filePath);
    if (file) return { label: 'Git', summary: `Diffing ${ truncate(file, 50) }` };
    if (args.staged) return { label: 'Git', summary: 'Diffing staged changes' };
    return { label: 'Git', summary: 'Comparing changes' };
  },
  git_log(args) {
    const limit = args.limit ?? 10;
    return { label: 'Git', summary: `Showing last ${ limit } commits` };
  },
  git_add(args) {
    const files = Array.isArray(args.files) ? args.files : [];
    return { label: 'Git', summary: `Staging ${ files.length || 'all' } file${ files.length === 1 ? '' : 's' }` };
  },
  git_branch(args) {
    const action = str(args.action) || 'Managing';
    const name = str(args.branchName);
    return { label: 'Git', summary: `${ action } branch${ name ? ` ${ name }` : '' }` };
  },
  git_checkout(args) {
    const ref = str(args.ref);
    return { label: 'Git', summary: `Checking out ${ truncate(ref || 'files', 40) }` };
  },
  git_stash(args) {
    const action = str(args.action) || 'stash';
    return { label: 'Git', summary: `Stash: ${ action }` };
  },
  git_blame(args) {
    return { label: 'Git', summary: `Blaming lines ${ args.startLine ?? '?' }–${ args.endLine ?? '?' }` };
  },
  git_conflicts() { return { label: 'Git', summary: 'Listing merge conflicts' }; },

  // ── GitHub ───────────────────────────────────────────────────────────────
  github_create_pr(args) {
    return { label: 'GitHub', summary: `Creating PR: ${ truncate(str(args.title), 55) }` };
  },
  github_create_issue(args) {
    return { label: 'GitHub', summary: `Creating issue: ${ truncate(str(args.title), 50) }` };
  },
  github_get_issue(args) {
    return { label: 'GitHub', summary: `Fetching issue #${ args.issue_number }` };
  },
  github_get_issues(args) {
    const state = str(args.state) || 'open';
    const repo = `${ str(args.owner) }/${ str(args.repo) }`;
    return { label: 'GitHub', summary: `Fetching ${ state } issues from ${ repo }` };
  },
  github_read_file(args) {
    return { label: 'GitHub', summary: `Reading ${ truncate(str(args.path), 50) }` };
  },
  github_create_file(args) {
    return { label: 'GitHub', summary: `Creating ${ truncate(str(args.path), 50) }` };
  },
  github_update_file(args) {
    return { label: 'GitHub', summary: `Updating ${ truncate(str(args.path), 50) }` };
  },
  github_comment_on_issue(args) {
    return { label: 'GitHub', summary: `Commenting on #${ args.issue_number }` };
  },
  github_close_issue(args) {
    return { label: 'GitHub', summary: `Closing issue #${ args.issue_number }` };
  },
  github_update_issue(args) {
    return { label: 'GitHub', summary: `Updating issue #${ args.issue_number }` };
  },
  github_list_branches(args) {
    return { label: 'GitHub', summary: `Listing branches on ${ str(args.owner) }/${ str(args.repo) }` };
  },
  github_add_remote(args) {
    return { label: 'Git', summary: `Adding remote ${ str(args.remoteName) }` };
  },
  github_init() { return { label: 'Git', summary: 'Initializing repository' }; },

  // ── Docker ───────────────────────────────────────────────────────────────
  docker_build(args) {
    return { label: 'Docker', summary: `Building image${ args.tag ? ` ${ str(args.tag) }` : '' }` };
  },
  docker_run(args) {
    const name = str(args.name);
    const image = str(args.image);
    return { label: 'Docker', summary: `Running ${ name || image }`, input: str(args.command) || undefined };
  },
  docker_exec(args) {
    return { label: 'Docker', summary: `Executing in ${ str(args.container) }`, input: str(args.command) || undefined };
  },
  docker_ps(args) {
    return { label: 'Docker', summary: `Listing ${ args.all ? 'all ' : '' }containers` };
  },
  docker_logs(args) {
    const tail = args.tail ? ` (last ${ args.tail })` : '';
    return { label: 'Docker', summary: `Reading logs from ${ str(args.container) }${ tail }` };
  },
  docker_pull(args) {
    return { label: 'Docker', summary: `Pulling ${ truncate(str(args.image), 50) }` };
  },
  docker_stop(args) {
    return { label: 'Docker', summary: `Stopping ${ str(args.container) }` };
  },
  docker_rm(args) {
    return { label: 'Docker', summary: `Removing ${ str(args.container) }` };
  },
  docker_images(args) {
    return { label: 'Docker', summary: `Listing ${ args.all ? 'all ' : '' }images` };
  },

  // ── Slack ────────────────────────────────────────────────────────────────
  slack_send_message(args) {
    return { label: 'Slack', summary: `Messaging ${ str(args.channel) }`, input: truncate(str(args.text), 80) };
  },
  slack_search_users(args) {
    return { label: 'Slack', summary: `Searching users: ${ truncate(str(args.query), 40) }` };
  },
  slack_update(args) {
    return { label: 'Slack', summary: `Updating message in ${ str(args.channel) }` };
  },
  slack_thread(args) {
    return { label: 'Slack', summary: `Reading thread in ${ str(args.channel) }` };
  },
  slack_user() {
    return { label: 'Slack', summary: 'Looking up user' };
  },
  slack_unreact(args) {
    return { label: 'Slack', summary: `Removing :${ str(args.reaction) }: from message` };
  },
  slack_connection_health() {
    return { label: 'Slack', summary: 'Checking Slack connection' };
  },

  // ── Database (PostgreSQL) ────────────────────────────────────────────────
  pg_query(args) {
    const sql = str(args.sql || args.query || args.statement);
    return { label: 'Database', summary: `Querying: ${ truncate(sql, 70) }`, input: sql || undefined, outputFormat: 'json' };
  },
  pg_queryall(args) {
    const sql = str(args.sql);
    return { label: 'Database', summary: `Querying all: ${ truncate(sql, 65) }`, input: sql || undefined, outputFormat: 'json' };
  },
  pg_queryone(args) {
    const sql = str(args.sql);
    return { label: 'Database', summary: `Querying one: ${ truncate(sql, 65) }`, input: sql || undefined, outputFormat: 'json' };
  },
  pg_execute(args) {
    const sql = str(args.sql || args.query || args.statement);
    return { label: 'Database', summary: `Executing: ${ truncate(sql, 68) }`, input: sql || undefined };
  },
  pg_count(args) {
    const sql = str(args.sql);
    return { label: 'Database', summary: `Counting: ${ truncate(sql, 68) }`, input: sql || undefined };
  },
  pg_transaction(args) {
    return { label: 'Database', summary: 'Running transaction', input: truncate(str(args.sql), 80) || undefined };
  },

  // ── Redis ────────────────────────────────────────────────────────────────
  redis_get(args)     { return { label: 'Redis', summary: `Getting ${ str(args.key) }` }; },
  redis_set(args)     { return { label: 'Redis', summary: `Setting ${ str(args.key) }` }; },
  redis_del(args) {
    const keys = Array.isArray(args.keys) ? args.keys : [];
    return { label: 'Redis', summary: `Deleting ${ keys.length } key${ keys.length === 1 ? '' : 's' }` };
  },
  redis_hget(args)    { return { label: 'Redis', summary: `Getting ${ str(args.key) }.${ str(args.field) }` }; },
  redis_hgetall(args) { return { label: 'Redis', summary: `Getting all fields of ${ str(args.key) }` }; },
  redis_hset(args)    { return { label: 'Redis', summary: `Setting ${ str(args.key) }.${ str(args.field) }` }; },
  redis_incr(args)    { return { label: 'Redis', summary: `Incrementing ${ str(args.key) }` }; },
  redis_decr(args)    { return { label: 'Redis', summary: `Decrementing ${ str(args.key) }` }; },
  redis_lpop(args)    { return { label: 'Redis', summary: `Popping from ${ str(args.key) }` }; },
  redis_rpush(args)   { return { label: 'Redis', summary: `Appending to ${ str(args.key) }` }; },
  redis_expire(args)  { return { label: 'Redis', summary: `Setting TTL on ${ str(args.key) }` }; },
  redis_ttl(args)     { return { label: 'Redis', summary: `Checking TTL of ${ str(args.key) }` }; },

  // ── Calendar ─────────────────────────────────────────────────────────────
  calendar_create(args) {
    return { label: 'Calendar', summary: `Creating event: ${ truncate(str(args.title), 50) }` };
  },
  calendar_list() {
    return { label: 'Calendar', summary: 'Listing events' };
  },
  calendar_list_upcoming(args) {
    return { label: 'Calendar', summary: `Checking next ${ args.days ?? 7 } days` };
  },
  calendar_get() {
    return { label: 'Calendar', summary: 'Getting event details' };
  },
  calendar_update(args) {
    return { label: 'Calendar', summary: `Updating event${ args.title ? `: ${ truncate(str(args.title), 45) }` : '' }` };
  },
  calendar_cancel() {
    return { label: 'Calendar', summary: 'Cancelling event' };
  },
  calendar_delete() {
    return { label: 'Calendar', summary: 'Deleting event' };
  },

  // ── N8N / Workflows ──────────────────────────────────────────────────────
  execute_workflow(args) {
    return { label: 'Workflow', summary: `Running workflow ${ str(args.workflowId) }` };
  },
  validate_workflow(args) {
    return { label: 'Workflow', summary: `Validating workflow ${ str(args.workflowId) }` };
  },
  validate_workflow_payload(args) {
    return { label: 'Workflow', summary: `Validating payload: ${ truncate(str(args.name), 40) }` };
  },
  patch_workflow(args) {
    const ops = Array.isArray(args.operations) ? args.operations.length : '?';
    return { label: 'Workflow', summary: `Patching workflow ${ str(args.workflowId) } (${ ops } operations)` };
  },
  diagnose_webhook(args) {
    return { label: 'Workflow', summary: `Diagnosing webhook for ${ str(args.workflowId) }` };
  },
  restart_n8n_container() {
    return { label: 'Workflow', summary: 'Restarting n8n container' };
  },
  restart_from_checkpoint(args) {
    return { label: 'Workflow', summary: `Restarting from node ${ str(args.nodeId) }` };
  },

  // ── Extensions ───────────────────────────────────────────────────────────
  install_extension(args) {
    return { label: 'Extensions', summary: `Installing ${ truncate(str(args.id), 40) }` };
  },
  uninstall_extension(args) {
    return { label: 'Extensions', summary: `Uninstalling ${ truncate(str(args.id), 40) }` };
  },
  list_installed_extensions() {
    return { label: 'Extensions', summary: 'Listing installed extensions' };
  },
  list_extension_catalog(args) {
    const q = str(args.query);
    return { label: 'Extensions', summary: q ? `Searching extensions: ${ truncate(q, 40) }` : 'Browsing extension catalog' };
  },

  // ── Lima (VM) ────────────────────────────────────────────────────────────
  lima_shell(args) {
    return { label: 'Lima', summary: `Running in VM`, input: str(args.command) || undefined };
  },
  lima_start(args) {
    return { label: 'Lima', summary: `Starting VM ${ str(args.instance) || '0' }` };
  },
  lima_stop(args) {
    return { label: 'Lima', summary: `Stopping VM ${ str(args.instance) || '0' }` };
  },
  lima_list() {
    return { label: 'Lima', summary: 'Listing VMs' };
  },
  lima_create(args) {
    return { label: 'Lima', summary: `Creating VM${ args.template ? ` from ${ str(args.template) }` : '' }` };
  },
  lima_delete(args) {
    return { label: 'Lima', summary: `Deleting VM ${ str(args.instance) }` };
  },

  // ── Agents ───────────────────────────────────────────────────────────────
  spawn_agent(args) {
    const tasks = Array.isArray(args.tasks) ? args.tasks.length : '?';
    return { label: 'Agents', summary: `Spawning ${ tasks } sub-agent${ tasks === 1 ? '' : 's' }` };
  },
  check_agent_jobs(args) {
    return { label: 'Agents', summary: `Checking job ${ truncate(str(args.jobId), 20) }` };
  },
  list_agents() {
    return { label: 'Agents', summary: 'Listing available agents' };
  },

  // ── Bridge ───────────────────────────────────────────────────────────────
  send_notification_to_human(args) {
    return { label: 'Bridge', summary: `Notifying human` };
  },
  emit_html_message(args) {
    return { label: 'Bridge', summary: `Sending rich message${ args.title ? `: ${ truncate(str(args.title), 40) }` : '' }` };
  },
  update_human_presence() {
    return { label: 'Bridge', summary: 'Updating presence' };
  },
  get_human_presence() {
    return { label: 'Bridge', summary: 'Checking presence' };
  },

  // ── Memory / Meta ────────────────────────────────────────────────────────
  add_observational_memory(args, result) {
    const content = str(args.content);
    const output = extractOutput(result);
    return {
      label:   'Memory',
      summary: content ? `Remembering: "${ truncate(content, 60) }"` : 'Remembering observation',
      output:  output || undefined,
    };
  },
  remove_observational_memory(args, result) {
    const id = str(args.id);
    const output = extractOutput(result);
    // The result contains the content of what was forgotten
    const content = output?.match(/Forgetting:\s*"(.+?)"/)?.[1];
    return {
      label:   'Memory',
      summary: content ? `Forgetting: "${ truncate(content, 60) }"` : `Forgetting observation ${ id }`,
      output:  output || undefined,
    };
  },
  // ── Workspace ────────────────────────────────────────────────────────────
  create_workspace(args) {
    return { label: 'Workspace', summary: `Creating workspace ${ str(args.name) }` };
  },
  delete_workspace(args) {
    return { label: 'Workspace', summary: `Deleting workspace ${ str(args.name) }` };
  },
  get_workspace_path(args) {
    return { label: 'Workspace', summary: `Getting path for ${ str(args.name) }` };
  },
  view_workspace_files(args) {
    return { label: 'Workspace', summary: `Listing files in ${ str(args.name) }` };
  },

  // ── Skills ───────────────────────────────────────────────────────────────
  load_skill(args) {
    return { label: 'Skills', summary: `Loading skill: ${ str(args.skill_name) }` };
  },
  create_skill(args) {
    return { label: 'Skills', summary: `Creating skill: ${ str(args.skill_name) }` };
  },

  // ── Integrations ─────────────────────────────────────────────────────────
  integration_list() {
    return { label: 'Integrations', summary: 'Listing integrations' };
  },
  vault_is_enabled(args) {
    return { label: 'Vault', summary: `Checking ${ str(args.account_type) }` };
  },
  vault_read_secrets(args) {
    return { label: 'Vault', summary: `Reading credentials for ${ str(args.account_type) }` };
  },
  vault_list_accounts(args) {
    return { label: 'Vault', summary: `Listing accounts for ${ str(args.account_type) }` };
  },
  vault_set_active_account(args) {
    return { label: 'Vault', summary: `Setting active account for ${ str(args.account_type) }` };
  },
  vault_set_credential(args) {
    return { label: 'Vault', summary: `Saving credential for ${ str(args.account_type) }` };
  },

  // ── Kubectl ──────────────────────────────────────────────────────────────
  kubectl_apply(args) {
    return { label: 'Kubernetes', summary: 'Applying manifest' };
  },
  kubectl_delete() {
    return { label: 'Kubernetes', summary: 'Deleting resource' };
  },
  kubectl_describe() {
    return { label: 'Kubernetes', summary: 'Describing resource' };
  },

  // ── rdctl ────────────────────────────────────────────────────────────────
  // Fallback handled by prefix matching below
};

// ── Exec formatter (reused by multiple aliases) ────────────────────────────

function execFormatter(args: Args, result?: unknown): Partial<ToolCardDisplay> {
  const cmd = str(args.command || args.cmd);
  return {
    label:        'Bash',
    summary:      cmd ? truncate(cmd, 70) : 'Running command',
    input:        cmd || undefined,
    output:       extractOutput(result),
    outputFormat: 'code',
  };
}

// ── Prefix-based fallback labels ───────────────────────────────────────────

const PREFIX_LABELS: [string, string][] = [
  ['fs_',      'Files'],
  ['git',      'Git'],
  ['github_',  'GitHub'],
  ['docker_',  'Docker'],
  ['kubectl_', 'Kubernetes'],
  ['pg_',      'Database'],
  ['redis_',   'Redis'],
  ['slack_',   'Slack'],
  ['n8n_',     'Workflow'],
  ['lima_',    'Lima'],
  ['calendar_', 'Calendar'],
];

function fallbackLabel(toolName: string): string {
  for (const [prefix, label] of PREFIX_LABELS) {
    if (toolName.startsWith(prefix)) return label;
  }
  return 'Tool';
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Format a tool call for human-friendly display.
 * Called once on tool_call (args only) and optionally again on tool_result.
 */
export function formatToolCard(
  toolName: string,
  args: Args,
  result?: unknown,
): ToolCardDisplay {
  const formatter = formatters[toolName];
  if (formatter) {
    const partial = formatter(args, result);
    return {
      label:        partial.label ?? fallbackLabel(toolName),
      summary:      partial.summary ?? toolName,
      input:        partial.input,
      output:       partial.output,
      outputFormat: partial.outputFormat,
    };
  }

  // Generic fallback — humanize the tool name
  const humanName = toolName.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return {
    label:  fallbackLabel(toolName),
    summary: humanName,
  };
}

/**
 * Format tool result output for display, given an existing display and new result data.
 * Updates the output field based on the tool's result.
 */
export function formatToolResult(
  toolName: string,
  args: Args,
  result: unknown,
  error?: string | null,
): { output?: string; outputFormat?: 'text' | 'code' | 'url' | 'json' } {
  // Re-run the formatter with the result to get updated output
  const formatter = formatters[toolName];
  if (formatter) {
    const partial = formatter(args, result);
    const output = partial.output ?? extractOutput(result);
    return { output, outputFormat: partial.outputFormat };
  }

  return { output: extractOutput(result) };
}
