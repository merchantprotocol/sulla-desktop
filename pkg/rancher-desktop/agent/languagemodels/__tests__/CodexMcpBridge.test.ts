import { describe, expect, it } from '@jest/globals';

import { buildCodexMcpOverrides, CODEX_MCP_TOKEN_ENV } from '../codexMcpConfig';

describe('CodexService MCP bridge', () => {
  it('injects the graph-bound Sulla MCP server without writing persistent Codex config', () => {
    const overrides = buildCodexMcpOverrides({
      url: 'http://host.lima.internal:43123/mcp',
    });

    expect(overrides).toEqual([
      'mcp_servers.sulla-native.url="http://host.lima.internal:43123/mcp"',
      'mcp_servers.sulla-native.bearer_token_env_var="SULLA_MCP_SESSION_TOKEN"',
    ]);
    expect(CODEX_MCP_TOKEN_ENV).toBe('SULLA_MCP_SESSION_TOKEN');
  });

  it('does not add MCP configuration when no graph state session is available', () => {
    expect(buildCodexMcpOverrides()).toEqual([]);
  });
});
