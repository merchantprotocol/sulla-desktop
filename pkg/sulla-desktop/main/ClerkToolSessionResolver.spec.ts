// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { ClerkToolSessionResolver } from './ClerkToolSessionResolver';
import { AgentAwarenessPolicy } from '@pkg/agent/services/AgentAwarenessPolicy';

import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';
import type { ToolSession } from './mcpToolSessions';

const now = Date.parse('2026-11-23T17:00:00Z');
const context: ToolExecutionContext = {
  v: 1, iss: 'test-desktop', aud: 'sulla-tools', iat: Math.floor(now / 1_000),
  sub: 'user-a', agent_id: 'agent-a', pod_id: 'pod-a', thread_id: 'thread-a',
  exp: Math.floor(now / 1_000) + 300, scopes: [], request_id: 'request-a', jti: 'jti-a',
};

const paired = { generation: context.jti, expiresAt: now + 30_000 };
function fixture(session: ToolSession | null = {
  id: 'bearer-a', clerk: paired,
  state: { metadata: { agentId: 'agent-a', threadId: 'thread-a', allowedToolNames: ['clerk_delete_user'] } } as any,
  createdAt: now, lastUsedAt: now, expiresAt: now + 30_000, ttlMs: 30_000,
  executionContext: context,
}) {
  const getToolSession = vi.fn(() => session);
  const issueLocalBrokerContext = vi.fn(async() => context);
  const resolver = new ClerkToolSessionResolver(
    { getToolSession }, { issueLocalBrokerContext }, () => 'installation-token', new AgentAwarenessPolicy(), () => now,
  );
  return { resolver, getToolSession, issueLocalBrokerContext, setSession: (next: ToolSession | null) => { session = next } };
}

const request = (authorization = 'Bearer bearer-a', extra: Record<string, string | string[] | undefined> = {}) => ({
  headers: { authorization, ...extra },
});

describe('Clerk tool-session authorization', () => {
  it('binds to the authenticated bearer and rejects blank or mismatched session headers before lookup', async() => {
    const f = fixture();
    await expect(f.resolver.resolve(request('Bearer bearer-a', { 'x-sulla-tool-session': 'bearer-b' }), 'clerk_delete_user', new AbortController().signal))
      .rejects.toThrow('must match');
    await expect(f.resolver.resolve(request('Bearer bearer-a', { 'x-sulla-tool-session': '  ' }), 'clerk_delete_user', new AbortController().signal))
      .rejects.toThrow('must match');
    expect(f.getToolSession).not.toHaveBeenCalled();
  });

  it('rejects missing, installation-only, expired, disallowed, and agentless contexts', async() => {
    const f = fixture();
    await expect(f.resolver.resolve(request(''), 'clerk_delete_user', new AbortController().signal)).rejects.toThrow('bearer');
    await expect(f.resolver.resolve(request('Bearer installation-token'), 'clerk_delete_user', new AbortController().signal)).rejects.toThrow('verified agent');
    await expect(f.resolver.resolve(request(), 'clerk_create_user', new AbortController().signal)).rejects.toThrow('not authorized');

    f.setSession({ ...({} as ToolSession), id: 'bearer-a', clerk: paired, state: { metadata: { agentId: 'agent-a', threadId: 'thread-a', allowedToolNames: ['clerk_delete_user'] } } as any,
      createdAt: now, lastUsedAt: now, expiresAt: now, ttlMs: 30_000, executionContext: { ...context, exp: Math.floor(now / 1_000) - 1 } });
    await expect(f.resolver.resolve(request(), 'clerk_delete_user', new AbortController().signal)).rejects.toThrow('invalid or expired');

    f.setSession({ ...({} as ToolSession), id: 'bearer-a', clerk: paired, state: { metadata: { threadId: 'thread-a', allowedToolNames: ['clerk_delete_user'] } } as any,
      createdAt: now, lastUsedAt: now, expiresAt: now + 30_000, ttlMs: 30_000,
      executionContext: { ...context, agent_id: undefined } });
    await expect(f.resolver.resolve(request(), 'clerk_delete_user', new AbortController().signal)).rejects.toThrow('missing trusted agent context');
  });

  it('revalidates the same bearer session after an approval wait', async() => {
    const f = fixture();
    const caller = await f.resolver.resolve(request(), 'clerk_delete_user', new AbortController().signal);
    f.setSession(null);
    await expect(caller.revalidate?.()).rejects.toThrow('invalid or expired');
    expect(f.getToolSession).toHaveBeenCalledTimes(2);
  });

  it('authorizes and revalidates the registered prefixed Clerk tool name used by internal routes', async() => {
    const f = fixture({
      id: 'bearer-a', clerk: paired, state: { metadata: { agentId: 'agent-a', threadId: 'thread-a', allowedToolNames: ['clerk_list_users'] } } as any,
      createdAt: now, lastUsedAt: now, expiresAt: now + 30_000, ttlMs: 30_000, executionContext: context,
    });
    const caller = await f.resolver.resolve(request(), 'clerk_list_users', new AbortController().signal);

    expect(caller.toolName).toBe('clerk_list_users');
    await expect(caller.revalidate?.()).resolves.toMatchObject({ agent_id: 'agent-a' });
    expect(f.getToolSession).toHaveBeenCalledTimes(2);
  });

  it('resolves and revalidates the authenticated MCP session captured by a projected tool handler', async() => {
    const f = fixture();
    const signal = new AbortController().signal;
    const caller = await f.resolver.resolveSession('bearer-a', 'clerk_delete_user', signal);

    expect(caller.signal).toBeDefined();
    expect(caller.revalidate).toBeDefined();
    f.setSession(null);
    await expect(caller.revalidate?.()).rejects.toThrow('invalid or expired');
    expect(f.getToolSession).toHaveBeenCalledTimes(2);
  });

  it('creates a broker context only from trusted session agent and thread metadata', async() => {
    const f = fixture({
      id: 'bearer-a', clerk: 'local', state: { metadata: { agentId: 'agent-a', threadId: 'thread-a', allowedToolNames: ['clerk_delete_user'] } } as any,
      createdAt: now, lastUsedAt: now, expiresAt: now + 30_000, ttlMs: 30_000,
    });
    await f.resolver.resolve(request(), 'clerk_delete_user', new AbortController().signal);
    expect(f.issueLocalBrokerContext).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-a', threadId: 'thread-a', credentialScope: { integration_id: 'clerk', account_id: 'default' },
    }));
  });
});
