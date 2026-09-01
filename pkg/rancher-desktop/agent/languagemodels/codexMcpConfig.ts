import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import type { RegisteredSession } from '@pkg/main/MCPServerHost';

export const CODEX_MCP_TOKEN_ENV = 'SULLA_MCP_SESSION_TOKEN';

interface CodexMcpSessionConfig {
  url: string;
}

interface CodexMcpSessionHost {
  running: boolean;
  registerSession(state: BaseThreadState): RegisteredSession;
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
  return host.registerSession(state);
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
