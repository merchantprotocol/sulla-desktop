export const CODEX_MCP_TOKEN_ENV = 'SULLA_MCP_SESSION_TOKEN';

interface CodexMcpSessionConfig {
  url: string;
}

/** Per-process Codex CLI overrides for Sulla's graph-bound MCP bridge. */
export function buildCodexMcpOverrides(session?: CodexMcpSessionConfig | null): string[] {
  if (!session) return [];
  return [
    `mcp_servers.sulla-native.url=${ JSON.stringify(session.url) }`,
    `mcp_servers.sulla-native.bearer_token_env_var=${ JSON.stringify(CODEX_MCP_TOKEN_ENV) }`,
  ];
}
