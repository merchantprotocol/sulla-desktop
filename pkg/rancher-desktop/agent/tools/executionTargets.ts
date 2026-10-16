export type ToolExecutionTarget = 'catalog' | 'controller' | 'workflow-manager' | 'agent-local' | 'desktop-local';

export const INTERNAL_TOOL_CATEGORIES = new Set([
  'agents', 'applescript', 'bridge', 'bookmarks', 'browser', 'calendar', 'capture', 'chat',
  'docker', 'extensions', 'fs', 'function', 'gdrive', 'github', 'integrations', 'kubectl',
  'ledger', 'lima', 'marketplace', 'memory', 'meta', 'mobile', 'models', 'notify', 'observation',
  'pg', 'project', 'projects', 'rdctl', 'redis', 'reflex', 'rules', 'secretary', 'settings',
  'skills', 'slack', 'ui', 'vault', 'workflow', 'workspace',
]);

const CONTROLLER_TOOLS = new Set(['spawn_agent', 'check_agent_jobs', 'send_job_message', 'stop_agent_job', 'start_agent_conversation', 'send_agent_message', 'read_agent_conversation', 'close_agent_conversation', 'list_agents', 'directory', 'report_progress', 'return_result']);
const WORKFLOW_MANAGER_TOOLS = new Set(['execute_workflow', 'pause_workflow', 'resume_workflow', 'stop_workflow', 'restart_from_checkpoint', 'catch_up_schedules', 'refresh_schedules', 'set_workflow_status', 'import_workflow']);
const AGENT_LOCAL_CATEGORIES = new Set(['fs', 'github', 'projects', 'workspace']);
const AGENT_LOCAL_TOOLS = new Set(['exec', 'read_file', 'write_file', 'file_search']);
const CATALOG_CATEGORIES = new Set(['pg', 'redis', 'project']);

/** Phase-one target inventory. Unlisted tools stay on Desktop until extracted. */
export function executionTargetFor(category: string, name: string): ToolExecutionTarget {
  if (name === 'reconcile_github_pr_mirror') return 'desktop-local';
  if (CATALOG_CATEGORIES.has(category)) return 'catalog';
  if (CONTROLLER_TOOLS.has(name) || category === 'agents') return 'controller';
  if (WORKFLOW_MANAGER_TOOLS.has(name)) return 'workflow-manager';
  if (AGENT_LOCAL_CATEGORIES.has(category) || AGENT_LOCAL_TOOLS.has(name)) return 'agent-local';
  return 'desktop-local';
}
