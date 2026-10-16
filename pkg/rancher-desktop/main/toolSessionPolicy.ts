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

/** Installation token or a currently-live graph-bound container token. */
export function apiRequestTokenIsValid(
  token: string | undefined,
  installationToken: string | null,
  hasScopedSession: (token: string) => boolean,
  requestPath = '/v1/tools/internal',
): boolean {
  if (!token) return false;
  if (token === installationToken) return true;
  const toolCatalogRoute = requestPath.startsWith('/v1/tools/') || requestPath.startsWith('/v1/proxy/');
  return toolCatalogRoute && hasScopedSession(token);
}
