import { describe, expect, it, jest } from '@jest/globals';

import { bindCodexMcpSession, buildCodexMcpOverrides, CODEX_MCP_TOKEN_ENV } from '../codexMcpConfig';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';
import type { RegisteredSession } from '@pkg/main/MCPServerHost';

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

  it('rebinds an adopted token to the current live graph state', () => {
    const previousState = { metadata: { threadId: 'previous' } } as BaseThreadState;
    const currentState = { metadata: { threadId: 'current' } } as BaseThreadState;
    const session: RegisteredSession = { id: 'token', url: 'http://host/mcp', header: 'Bearer token', revoke: jest.fn() };
    let registeredState: BaseThreadState | undefined;
    const host = {
      running:         true,
      registerSession: (state: BaseThreadState) => { registeredState = state; return session },
      rebindSession:   jest.fn<(id: string, state: BaseThreadState) => boolean>().mockReturnValue(true),
    };

    expect(bindCodexMcpSession(host, currentState, session)).toBe(session);
    expect(host.rebindSession).toHaveBeenCalledWith('token', currentState);
    expect(host.rebindSession).not.toHaveBeenCalledWith('token', previousState);
    expect(registeredState).toBeUndefined();
  });

  it('replaces an expired adopted token with a session bound to the current state', () => {
    const currentState = { metadata: { threadId: 'current' } } as BaseThreadState;
    const expired: RegisteredSession = { id: 'expired', url: 'http://host/mcp', header: 'Bearer expired', revoke: jest.fn() };
    const replacement: RegisteredSession = { id: 'fresh', url: 'http://host/mcp', header: 'Bearer fresh', revoke: jest.fn() };
    let registeredState: BaseThreadState | undefined;
    const host = {
      running:         true,
      registerSession: (state: BaseThreadState) => { registeredState = state; return replacement },
      rebindSession:   jest.fn<(id: string, state: BaseThreadState) => boolean>().mockReturnValue(false),
    };

    expect(bindCodexMcpSession(host, currentState, expired)).toBe(replacement);
    expect(expired.revoke).toHaveBeenCalledTimes(1);
    expect(registeredState).toBe(currentState);
  });
});
