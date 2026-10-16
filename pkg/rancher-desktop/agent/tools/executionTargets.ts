export type ToolExecutionTarget = 'catalog' | 'controller' | 'workflow-manager' | 'agent-local' | 'desktop-local';

const CONTROLLER_TOOLS = new Set(['spawn_agent', 'check_agent_jobs', 'send_job_message', 'stop_agent_job', 'start_agent_conversation', 'send_agent_message', 'read_agent_conversation', 'close_agent_conversation', 'list_agents', 'directory', 'report_progress', 'return_result']);
const WORKFLOW_MANAGER_TOOLS = new Set(['execute_workflow', 'pause_workflow', 'resume_workflow', 'stop_workflow', 'restart_from_checkpoint', 'catch_up_schedules', 'refresh_schedules', 'set_workflow_status', 'import_workflow']);
const AGENT_LOCAL_CATEGORIES = new Set(['fs', 'projects', 'workspace']);
const AGENT_LOCAL_TOOLS = new Set(['exec', 'read_file', 'write_file', 'file_search']);
const CATALOG_CATEGORIES = new Set(['files', 'pg', 'redis', 'project']);

/** Phase-one target inventory. Unlisted tools stay on Desktop until extracted. */
export function executionTargetFor(category: string, name: string): ToolExecutionTarget {
  const bareName = name.startsWith(`${ category }_`) ? name.slice(category.length + 1) : name;

  if (bareName === 'reconcile_github_pr_mirror') return 'desktop-local';
  if (CATALOG_CATEGORIES.has(category)) return 'catalog';
  if (CONTROLLER_TOOLS.has(bareName) || category === 'agents') return 'controller';
  if (WORKFLOW_MANAGER_TOOLS.has(bareName)) return 'workflow-manager';
  if (category === 'github' && (bareName.startsWith('git_') || bareName === 'add_remote' || bareName === 'init')) return 'agent-local';
  if (AGENT_LOCAL_CATEGORIES.has(category) || AGENT_LOCAL_TOOLS.has(bareName)) return 'agent-local';
  return 'desktop-local';
}
