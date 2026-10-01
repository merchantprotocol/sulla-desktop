/**
 * Which Sulla tools a session-bound CLI call may run.
 *
 * A graph agent's `allowedToolNames` lists its native tool surface. `exec` in
 * that list is the agent's bridge to the whole `sulla` CLI catalog, so a
 * session allowed `exec` may run every catalog tool — including interactive
 * ones like ask_user_question. Every agent gets the same full access.
 */

export function sessionAllowsTool(allowed: unknown, toolName: string): boolean {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  if (allowed.includes(toolName)) return true;

  return allowed.includes('exec');
}
