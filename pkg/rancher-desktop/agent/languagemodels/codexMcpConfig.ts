import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import type { RegisteredSession } from '@pkg/main/MCPServerHost';

export const CODEX_MCP_TOKEN_ENV = 'SULLA_MCP_SESSION_TOKEN';

interface CodexMcpSessionConfig {
  url: string;
}

/**
 * Tool-session lifetime for a Codex worker. The default 10-min idle TTL
 * expired mid-task whenever a worker went 10 min without a `sulla` call (a
 * long test run or edit), and every later check-in / return_result failed
 * with "Expired tool session". Matches ClaudeCodeService's process TTL; the
 * session is still revoked when the run ends.
 */
export const CODEX_MCP_SESSION_TTL_MS = 4 * 60 * 60_000 + 30 * 60_000;

interface CodexMcpSessionHost {
  running: boolean;
  registerSession(state: BaseThreadState, ttlMs?: number): RegisteredSession;
  rebindSession(id: string, state: BaseThreadState): boolean;
}

/** Bind an existing token to this turn, minting a replacement if it expired. */
export function bindCodexMcpSession(
  host: CodexMcpSessionHost,
  state: BaseThreadState,
  existing?: RegisteredSession | null,
): RegisteredSession | null {
  if (!host.running) return existing ?? null;
  if (existing && host.rebindSession(existing.id, state)) return existing;
  if (existing) {
    try { existing.revoke() } catch { /* already revoked */ }
  }
  return host.registerSession(state, CODEX_MCP_SESSION_TTL_MS);
}

/** Per-process Codex CLI overrides for Sulla's graph-bound MCP bridge. */
export function buildCodexMcpOverrides(session?: CodexMcpSessionConfig | null): string[] {
  if (!session) return [];
  return [
    `mcp_servers.sulla-native.url=${ JSON.stringify(session.url) }`,
    `mcp_servers.sulla-native.bearer_token_env_var=${ JSON.stringify(CODEX_MCP_TOKEN_ENV) }`,
    // The verifier intentionally runs with approval_policy=never.  Codex's
    // read-only shell sandbox still gates MCP calls unless the graph-bound
    // server is explicitly trusted, so approve this in-process, allowlisted
    // surface at the server boundary rather than weakening the shell sandbox.
    'mcp_servers.sulla-native.default_tools_approval_mode="approve"',
  ];
}
