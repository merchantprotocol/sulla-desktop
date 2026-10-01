/**
 * Which Sulla tools a session-bound CLI call may run.
 *
 * A graph agent's `allowedToolNames` lists its native tool surface. `exec` in
 * that list is the agent's bridge to the whole `sulla` CLI catalog (git,
 * GitHub, projects, …) — see MECHANICAL_WORKER_TOOLS in TaskDispatcherService
 * and HEARTBEAT_TOOLS in GraphRegistry. So a session allowed `exec` may run any
 * catalog tool through the CLI, except interactive tools: those need a human
 * on the channel and would deadlock an unattended agent. Sessions without
 * `exec` (read-only verifiers) are limited to exactly their list.
 */

const INTERACTIVE_TOOLS = new Set(['ask_user_question']);

export function sessionAllowsTool(allowed: unknown, toolName: string): boolean {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  if (allowed.includes(toolName)) return true;
  if (INTERACTIVE_TOOLS.has(toolName)) return false;

  return allowed.includes('exec');
}
