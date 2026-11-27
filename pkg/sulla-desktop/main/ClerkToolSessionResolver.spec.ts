// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import '../agent/tests/Support/TestHomeEnv';

vi.mock('electron', () => ({ default: { app: { getVersion: () => 'test', getPath: () => '/tmp' } }, app: { getVersion: () => 'test', getPath: () => '/tmp' } }));

import { CLERK_CONTAINER_DENIAL, ClerkToolSessionResolver } from './ClerkToolSessionResolver';
import { AgentAwarenessPolicy } from '@pkg/agent/services/AgentAwarenessPolicy';
import { AgentContainerRuntimeRegistry } from '@pkg/agent/services/AgentContainerRuntimeRegistry';
import { ContainerSessionLeases } from '@pkg/agent/services/ContainerSessionLeases';
import { deriveCapabilitySigningKey, verifyCapabilityToken } from '@pkg/runtime/capabilityToken';
import { MCPServerHost } from './MCPServerHost';
import { ClerkClient } from '@pkg/agent/integrations/clerk/ClerkClient';
import { clerkEndpoints } from '@pkg/agent/integrations/clerk/ClerkEndpoints';
import { clerkToolManifests } from '@pkg/agent/tools/clerk/manifests';
import { VaultApprovalRequiredError } from '../vault-broker';

import type { ClerkCaller } from '@pkg/agent/integrations/clerk/ClerkClient';
import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';
import type { ToolSession } from './mcpToolSessions';

const now = Date.now();
const context: ToolExecutionContext = {
  v: 1, iss: 'test-desktop', aud: 'sulla-tools', iat: Math.floor(now / 1_000),
  sub: 'user-a', agent_id: 'agent-a', pod_id: 'pod-a', thread_id: 'thread-a',
  exp: Math.floor(now / 1_000) + 300, scopes: [], request_id: 'request-a', jti: 'jti-a',
};

function fixture(session: ToolSession | null = {
  id: 'bearer-a', clerk: 'local',
  clerkGeneration: 'host-session-generation-a',
  state: { metadata: { agentId: 'agent-a', threadId: 'thread-a', allowedToolNames: ['clerk_delete_user'] } } as any,
  createdAt: now, lastUsedAt: now, expiresAt: now + 30_000, ttlMs: 30_000,
}) {
  const getToolSession = vi.fn((id: string) => session?.id === id ? session : null);
  const issueLocalBrokerContext = vi.fn((input: { agentId: string; podId: string; jobId?: string; orgId?: string; threadId: string }) => Promise.resolve({
    ...context, agent_id: input.agentId, pod_id: input.podId, job_id: input.jobId, org_id: input.orgId, thread_id: input.threadId,
  }));
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

    f.setSession({ ...({} as ToolSession), id: 'bearer-a', clerk: 'local', state: { metadata: { agentId: 'agent-a', threadId: 'thread-a', allowedToolNames: ['clerk_delete_user'] } } as any,
      createdAt: now, lastUsedAt: now, expiresAt: now, ttlMs: 30_000 });
    await expect(f.resolver.resolve(request(), 'clerk_delete_user', new AbortController().signal)).rejects.toThrow('invalid or expired');

    f.setSession({
      ...({} as ToolSession),
      id:              'bearer-a',
      clerk:           'local',
      clerkGeneration: 'host-session-generation-a',
      state:           { metadata: { threadId: 'thread-a', allowedToolNames: ['clerk_delete_user'] } } as any,
      createdAt:       now,
      lastUsedAt:      now,
      expiresAt:       now + 30_000,
      ttlMs:           30_000,
    });
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
      id:              'bearer-a',
      clerk:           'local',
      clerkGeneration: 'host-session-generation-a',
      state:           { metadata: { agentId: 'agent-a', threadId: 'thread-a', allowedToolNames: ['clerk_list_users'] } } as any,
      createdAt:       now,
      lastUsedAt:      now,
      expiresAt:       now + 30_000,
      ttlMs:           30_000,
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
      id:              'bearer-a',
      clerk:           'local',
      clerkGeneration: 'host-session-generation-a',
      state:           { metadata: { agentId: 'agent-a', threadId: 'thread-a', allowedToolNames: ['clerk_delete_user'] } } as any,
      createdAt:       now,
      lastUsedAt:      now,
      expiresAt:       now + 30_000,
      ttlMs:           30_000,
    });
    await f.resolver.resolve(request(), 'clerk_delete_user', new AbortController().signal);
    expect(f.issueLocalBrokerContext).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-a', threadId: 'thread-a', credentialScope: { integration_id: 'clerk', account_id: 'default' },
    }));
  });

  it('binds a host-local delegated job and task to its server-issued session generation', async() => {
    const f = fixture({
      id:              'bearer-a',
      clerk:           'local',
      clerkGeneration: 'host-session-generation-a',
      state:           {
        metadata: {
          agentId:            'agent-a',
          threadId:           'thread-a',
          delegatedJobId:     'job-delegated-a',
          delegatedTaskIndex: 4,
          allowedToolNames:   ['clerk_list_users'],
        },
      } as any,
      createdAt:  now,
      lastUsedAt: now,
      expiresAt:  now + 30_000,
      ttlMs:      30_000,
    });
    const caller = await f.resolver.resolveSession('bearer-a', 'clerk_list_users', new AbortController().signal);

    expect(f.issueLocalBrokerContext).toHaveBeenCalledWith(expect.objectContaining({
      agentId:  'agent-a',
      jobId:    'job-delegated-a',
      threadId: 'thread-a',
    }));
    expect(caller.execution).toMatchObject({ job_id: 'job-delegated-a', thread_id: 'thread-a' });
    expect(caller.binding).toEqual({ taskIndex: 4, generation: 'host-session-generation-a' });
  });

  it('does not redeem an approved operation from a replacement host-local session with the same agent and thread', async() => {
    const metadata = { agentId: 'agent-a', threadId: 'thread-a', allowedToolNames: ['clerk_delete_user'] };
    const first = {
      id:              'bearer-a',
      clerk:           'local',
      clerkGeneration: 'host-session-generation-a',
      state:           { metadata } as any,
      createdAt:       now,
      lastUsedAt:      now,
      expiresAt:       now + 30_000,
      ttlMs:           30_000,
    } as ToolSession;
    const f = fixture(first);
    const operationId = 'B'.repeat(43);
    const saved: any = {};
    const approval = () => ({
      id:             'decision-id',
      kind:           'approval',
      toolName:       'clerk',
      conversationId: 'thread-a',
      channel:        'sulla-desktop',
      payload:        { clerkOperationId: operationId, callerIdentity: saved.callerIdentity, requestHash: saved.requestHash },
      status:         'pending',
      expiresAt:      Date.now() + 60_000,
    });
    const decisions = {
      request:                vi.fn((input: any) => {
        Object.assign(saved, input.payload);
        return Promise.resolve({ record: approval() });
      }),
      findApprovalForPayload: vi.fn((key: string, value: string) => Promise.resolve(key === 'clerkOperationId' && value === operationId
        ? { ...approval(), status: saved.status ?? 'pending' } as any
        : undefined)),
    };
    const broker = {
      requestFor: vi.fn((_execution: ToolExecutionContext, input: Record<string, unknown>) => input),
      execute:    vi.fn((request: any) => {
        if (request.clerk.operationId) return Promise.resolve({ status: 200, headers: {}, body: {} });
        return Promise.reject(new VaultApprovalRequiredError(operationId, request, 'Vault approval required', {
          selectedEnvironment:  'production',
          effectiveEnvironment: 'production',
          instanceId:           'ins_live',
          method:               'DELETE',
          path:                 '/v1/users/user_fixture',
          query:                '',
          options:              {},
          action:               'clerk_delete_user',
          requesterAgentId:     'agent-a',
          jobId:                null,
          threadId:             'thread-a',
          changes:              {},
        } as any));
      }),
      integrationMetadata: vi.fn(),
    };
    const authorize = vi.fn(() => Promise.resolve('approval-id'));
    const client = new ClerkClient({
      broker:  broker as any,
      authorize,
      decisions,
      context: async caller => {
        const execution = caller.revalidate ? await caller.revalidate() : caller.execution;
        if (!execution) throw new Error('Missing trusted execution context');
        return { ...execution, credential_scope: { integration_id: 'clerk', account_id: 'default' } };
      },
    });

    const firstCaller = await f.resolver.resolveSession(first.id, 'clerk_delete_user', new AbortController().signal);
    const args = { user_id: 'user_fixture', environment: 'production', confirm: true };
    await expect(client.named('delete_user', args, firstCaller)).resolves.toMatchObject({ status: 'approval_pending', operationId });
    saved.status = 'approved';
    f.setSession({ ...first, id: 'bearer-b', clerkGeneration: 'host-session-generation-b' });
    const replacement = await f.resolver.resolveSession('bearer-b', 'clerk_delete_user', new AbortController().signal);

    await expect(client.named('delete_user', { ...args, operationId }, replacement)).rejects.toThrow('not available to this caller');
    expect(firstCaller.binding?.generation).not.toBe(replacement.binding?.generation);
    expect(authorize).not.toHaveBeenCalled();
    expect(broker.execute).toHaveBeenCalledTimes(1);
  });
});

describe('forwarded Clerk session binding', () => {
  const name = 'clerk_get_user';
  const binding = {
    podId: 'pod-forwarded', subject: 'user-a', orgId: 'org-a', agentId: 'agent-a', jobId: 'job-a',
    taskIndex: 2, threadId: 'thread-a', deviceId: 'device-a', workspacePath: '/fixture',
  };
  const forwardedState = { metadata: { agentId: binding.agentId, threadId: binding.threadId, jobId: binding.jobId,
    allowedToolNames: [name] } } as any;
  const key = deriveCapabilitySigningKey('synthetic-clerk-forwarding-fixture');

  async function fixture(options: {
    registry?:      AgentContainerRuntimeRegistry;
    state?:         any;
    allowed?:       string[];
    scopes?:        string[];
    register?:      boolean;
    brokerSubject?: string;
    brokerOrgId?:   string;
    leaseVersion?:  '1' | '2'
  } = {}) {
    const host = new MCPServerHost();
    host['port'] = 1;
    const registry = options.registry ?? new AgentContainerRuntimeRegistry();
    const unregister = options.register === false ? () => {} : registry.register(binding);
    const allowed = options.allowed ?? [name];
    const state = options.state ?? { metadata: { ...forwardedState.metadata, allowedToolNames: allowed } };
    const session = host.registerSession(state, 60_000, binding);
    const leases = new ContainerSessionLeases(binding, host, options.scopes ?? [name], 'fixture-lifecycle', key, 60_000,
      { replace: async() => {}, remove: async() => {} }, options.leaseVersion ?? '2');
    const claims = await verifyCapabilityToken(leases.issue(session.id), key, { category: 'clerk', tool: name });
    const context: ToolExecutionContext = { ...claims, request_id: 'forwarded-request' };
    const issueLocalBrokerContext = vi.fn(async(input: { agentId: string; podId: string; credentialScope: NonNullable<ToolExecutionContext['credential_scope']>; threadId: string; jobId?: string; signal: AbortSignal }) => ({
      v:                1 as const,
      iss:              'sulla-desktop',
      aud:              'sulla-tools' as const,
      sub:              options.brokerSubject ?? binding.subject,
      org_id:           options.brokerOrgId ?? binding.orgId,
      agent_id:         input.agentId,
      pod_id:           input.podId,
      thread_id:        input.threadId,
      job_id:           input.jobId,
      credential_scope: input.credentialScope,
      scopes: [],
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 300,
      jti: 'broker-jti',
      request_id: 'broker-request',
    }));
    const resolver = new ClerkToolSessionResolver(host, { issueLocalBrokerContext }, () => 'installation-token', new AgentAwarenessPolicy(), Date.now, registry);
    const worker = { bindClerkCaller: vi.fn() } as any;
    const release = async() => { session.revoke(); unregister(); await leases.close(); };
    return { host, registry, unregister, session, state, leases, claims, context, issueLocalBrokerContext, resolver, worker, release };
  }

  it('binds a verified live container session to real broker identity and revalidates generation/task', async() => {
    const f = await fixture();
    try {
      await f.resolver.bindForwarded(f.worker, name, f.session.id, f.context, new AbortController().signal);
      const caller = f.worker.bindClerkCaller.mock.calls[0]?.[0] as ClerkCaller;
      const generation = f.host.peekToolSession(f.session.id)!.executionContext!.jti;
      expect(caller).toMatchObject({ binding: { taskIndex: binding.taskIndex, generation } });
      expect(caller.execution).toMatchObject({ pod_id: binding.podId, job_id: binding.jobId, task_index: binding.taskIndex,
        thread_id: binding.threadId, agent_id: binding.agentId, tool_session_generation: generation });
      expect(f.issueLocalBrokerContext).toHaveBeenCalledWith(expect.objectContaining({ agentId: binding.agentId,
        podId: binding.podId, jobId: binding.jobId, threadId: binding.threadId,
        credentialScope: { integration_id: 'clerk', account_id: 'default' } }));
      await expect(caller.revalidate?.()).resolves.toMatchObject({ pod_id: binding.podId, job_id: binding.jobId,
        task_index: binding.taskIndex, tool_session_generation: generation });
      expect(f.issueLocalBrokerContext).toHaveBeenCalledTimes(2);
      await f.host.rebindSession(f.session.id, f.state, 60_000, binding);
      await expect(caller.revalidate?.()).rejects.toMatchObject({ status: 403, message: expect.stringContaining(CLERK_CONTAINER_DENIAL) });
      expect(f.issueLocalBrokerContext).toHaveBeenCalledTimes(2);
    } finally { await f.release(); }
  });

  it('refuses a forwarded v1 lease with transport-v2 relaunch guidance', async() => {
    const f = await fixture({ leaseVersion: '1' });
    try {
      expect(f.context.tool_session_generation).toBeUndefined();
      await expect(f.resolver.bindForwarded(f.worker, name, f.session.id, f.context, new AbortController().signal))
        .rejects.toThrow('Clerk requires the current agent image (transport v2). Relaunch this agent after the image is available.');
      expect(f.issueLocalBrokerContext).not.toHaveBeenCalled();
    } finally { await f.release() }
  });

  it('refuses projected container Clerk calls after the Desktop pod binding is gone', async() => {
    const f = await fixture({ register: false });
    const worker = {
      name,
      metadata:        { category: 'clerk' },
      bindClerkCaller: vi.fn(),
      call:            vi.fn(() => Promise.resolve({ success: true, result: { data: [] } })),
    } as any;
    const { buildGraphToolHandler } = await import('./graphToolSurface');
    const handler = buildGraphToolHandler([name], () => Promise.resolve(worker), {
      state:              f.state,
      executionContext:   f.host.peekToolSession(f.session.id)!.executionContext,
      resolveClerkCaller: (toolName, signal) => f.resolver.resolveSession(f.session.id, toolName, signal, f.state),
      executionTarget:    () => undefined,
    }, new AgentAwarenessPolicy());

    try {
      const result = await handler({ tool: name, args: {} }, { signal: new AbortController().signal });
      expect(result.isError).toBe(true);
      expect(worker.bindClerkCaller).not.toHaveBeenCalled();
      expect(worker.call).not.toHaveBeenCalled();
    } finally { await f.release() }
  });

  it.each(['pod unregister', 'pod replacement', 'tool-session revoke', 'tool-session rebind'] as const)(
    'aborts a pending forwarded Clerk read before send on %s', async(action) => {
      const f = await fixture();
      const requestController = new AbortController();
      const worker = { bindClerkCaller: vi.fn() } as any;
      let startExecute!: () => void;
      const executeStarted = new Promise<void>(resolve => { startExecute = resolve });
      let sends = 0;
      const broker = {
        requestFor: vi.fn((_execution: ToolExecutionContext, input: Record<string, unknown>) => input),
        execute:    vi.fn(async(_request: unknown, signal?: AbortSignal) => {
          startExecute();
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) { reject(new Error('aborted before send')); return }
            signal?.addEventListener('abort', () => reject(new Error('aborted before send')), { once: true });
          });
          if (signal?.aborted) throw new Error('aborted before send');
          sends++;
          return { status: 200, headers: {}, body: { data: [] } };
        }),
        integrationMetadata: vi.fn(),
      };
      const client = new ClerkClient({
        broker:    broker as any,
        authorize: () => Promise.resolve('approval-id'),
        decisions: { request: () => Promise.reject(new Error('Unexpected approval')), findApprovalForPayload: () => Promise.resolve(undefined) },
        context:   async caller => {
          const execution = caller.revalidate ? await caller.revalidate() : caller.execution;
          if (!execution) throw new Error('Missing trusted execution context');
          return { ...execution, credential_scope: { integration_id: 'clerk', account_id: 'default' } };
        },
      });
      let unregisterReplacement = () => {};

      try {
        await f.resolver.bindForwarded(worker, name, f.session.id, f.context, requestController.signal);
        const caller = worker.bindClerkCaller.mock.calls[0]?.[0] as ClerkCaller;
        const pending = client.raw({ method: 'GET', path: '/users', environment: 'staging' }, caller);
        await executeStarted;
        if (action === 'pod unregister') f.unregister();
        else if (action === 'pod replacement') unregisterReplacement = f.registry.register({ ...binding });
        else if (action === 'tool-session revoke') f.session.revoke();
        else f.host.rebindSession(f.session.id, f.state, 60_000, binding);
        const abortedByLifecycle = caller.signal?.aborted ?? false;
        const finished = await Promise.race([
          pending.then(() => 'resolved', () => 'rejected'),
          new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 40)),
        ]);
        requestController.abort();
        await expect(pending).rejects.toThrow();
        expect(abortedByLifecycle).toBe(true);
        expect(finished).toBe('rejected');
        expect(broker.execute).toHaveBeenCalledOnce();
        expect(sends).toBe(0);
      } finally {
        unregisterReplacement();
        await f.release();
      }
    },
  );

  it.each([
    ['subject', { brokerSubject: 'another-subject' }],
    ['organization', { brokerOrgId: 'another-org' }],
  ] as const)('refuses an issued broker %s mismatch before binding the Clerk caller', async(_label, mismatch) => {
    const f = await fixture(mismatch);
    try {
      await expect(f.resolver.bindForwarded(f.worker, name, f.session.id, f.context, new AbortController().signal))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining(CLERK_CONTAINER_DENIAL) });
      expect(f.worker.bindClerkCaller).not.toHaveBeenCalled();
    } finally { await f.release() }
  });

  it('rechecks the issued broker subject and organization on every forwarded revalidation', async() => {
    const f = await fixture();
    const originalIssuer = f.issueLocalBrokerContext.getMockImplementation()!;
    let calls = 0;
    f.issueLocalBrokerContext.mockImplementation(async(input) => {
      const context = await originalIssuer(input);
      return calls++ === 0 ? context : { ...context, org_id: 'another-org' };
    });
    try {
      await f.resolver.bindForwarded(f.worker, name, f.session.id, f.context, new AbortController().signal);
      const caller = f.worker.bindClerkCaller.mock.calls[0]?.[0] as ClerkCaller;
      await expect(caller.revalidate?.()).rejects.toMatchObject({ status: 403, message: expect.stringContaining(CLERK_CONTAINER_DENIAL) });
      expect(f.issueLocalBrokerContext).toHaveBeenCalledTimes(2);
    } finally { await f.release() }
  });

  it('returns the host-local normalized result for every forwarded Clerk manifest', async() => {
    const names = clerkToolManifests.map(manifest => manifest.name);
    const f = await fixture({ allowed: names, scopes: names });
    const hostLocal = f.host.registerSession(f.state, 60_000);
    const requestContexts: ToolExecutionContext[] = [];
    const upstream = vi.fn(async() => ({ status: 200, headers: {}, body: { data: [], total_count: 0 } }));
    const broker = {
      requestFor: vi.fn((execution: ToolExecutionContext, input: Record<string, unknown>) => {
        requestContexts.push(execution);
        return { ...input, context: execution };
      }),
      execute: vi.fn((request: unknown) => upstream(request)),
      integrationMetadata: vi.fn(async() => ({
        accounts: [{ accountId: 'default', connected: true, properties: {
          staging_instance_id: 'ins_stage', staging_publishable_key: 'pk_test_FAKE',
        } }],
      })),
      integrationMetadataForAgent: vi.fn(() => Promise.resolve({
        accounts: [
          {
            accountId: 'default',
            connected: true,
            properties: {
              staging_instance_id: 'ins_stage',
              staging_publishable_key: 'pk_test_FAKE',
            },
          },
        ],
      })),
    };
    const client = new ClerkClient({
      broker: broker as any,
      authorize: async() => { throw new Error('Unexpected approval'); },
      decisions: { request: async() => { throw new Error('Unexpected approval'); }, findApprovalForPayload: async() => undefined },
      context: async caller => {
        const execution = caller.revalidate ? await caller.revalidate() : caller.execution;
        if (!execution) throw new Error('Missing trusted execution context');
        return { ...execution, credential_scope: { integration_id: 'clerk', account_id: 'default' } };
      },
    });
    const argsFor = (toolName: string): Record<string, unknown> => {
      if (toolName === 'clerk_get_config') return { environment: 'staging' };
      if (toolName === 'clerk_raw_request') return { environment: 'staging', path: '/users', method: 'GET' };
      const endpointName = toolName.slice('clerk_'.length);
      const endpoint = clerkEndpoints[endpointName];
      const args: Record<string, unknown> = { environment: 'staging' };
      for (const [, keyName] of endpoint.path.matchAll(/\{([a-z_]+)\}/g)) {
        args[keyName] = keyName === 'user_id' ? 'user_fixture'
          : keyName === 'organization_id' ? 'org_fixture'
            : keyName === 'session_id' ? 'sess_fixture'
              : keyName === 'invitation_id' ? 'inv_fixture' : 'identifier_fixture';
      }
      if (endpoint.paged) args.limit = 1;
      if (endpointName === 'list_sessions') args.filters = { user_id: 'user_fixture' };
      const bodies: Record<string, Record<string, unknown>> = {
        create_user: { email_address: ['fixture@example.test'] },
        update_user: { first_name: 'Fixture' },
        update_user_metadata: { public_metadata: { fixture: true } },
        create_organization: { name: 'Fixture' },
        update_organization: { name: 'Fixture' },
        update_organization_metadata: { public_metadata: { fixture: true } },
        add_membership: { user_id: 'user_fixture', role: 'org:member' },
        update_membership: { role: 'org:member' },
        create_organization_invitation: { email_address: 'fixture@example.test', role: 'org:member' },
        create_invitation: { email_address: 'fixture@example.test' },
        add_allowlist_identifier: { identifier: 'fixture@example.test' },
        add_blocklist_identifier: { identifier: 'fixture@example.test' },
      };
      if (endpoint.body || endpoint.optionalBody) args.body = bodies[endpointName] ?? {};
      if (endpoint.method === 'DELETE' || endpoint.path.endsWith('/revoke')) args.confirm = true;
      return args;
    };
    const run = async(toolName: string, callerKind: 'container' | 'host') => {
      let caller: ClerkCaller;
      if (callerKind === 'container') {
        const worker = { bindClerkCaller: vi.fn() } as any;
        await f.resolver.bindForwarded(worker, toolName, f.session.id, f.context, new AbortController().signal);
        caller = worker.bindClerkCaller.mock.calls[0]?.[0] as ClerkCaller;
      } else {
        caller = await f.resolver.resolveSession(hostLocal.id, toolName, new AbortController().signal);
      }
      return client.named(toolName.slice('clerk_'.length), argsFor(toolName), caller);
    };
    try {
      for (const toolName of names) {
        const [containerResult, hostResult] = await Promise.all([run(toolName, 'container'), run(toolName, 'host')]);
        expect(containerResult, toolName).toEqual(hostResult);
        expect(JSON.stringify(containerResult), toolName).not.toMatch(/sk_(?:test|live)_/i);
      }
      expect(upstream).toHaveBeenCalledTimes((names.length - 1) * 2);
      const forwardedContexts = requestContexts.filter(execution => execution.task_index !== undefined);
      expect(forwardedContexts).toHaveLength(names.length - 1);
      for (const execution of forwardedContexts) {
        expect(execution).toMatchObject({ agent_id: binding.agentId, pod_id: binding.podId, job_id: binding.jobId,
          thread_id: binding.threadId, task_index: binding.taskIndex,
          tool_session_generation: f.host.peekToolSession(f.session.id)!.executionContext!.jti });
      }
    } finally {
      hostLocal.revoke();
      await f.release();
    }
  });

  it('revalidates the forwarded lease when a pending Clerk approval is retried after stop', async() => {
    const deleteTool = 'clerk_delete_user';
    const f = await fixture({ allowed: [name, deleteTool], scopes: [name, deleteTool] });
    const operationId = 'A'.repeat(43);
    let decision: any;
    const decisions = {
      request: vi.fn(async(input: any) => {
        decision = { ...input, id: 'decision-id', status: 'pending', expiresAt: Date.now() + 60_000 };
        return { record: decision, result: Promise.resolve({ status: 'approved', answers: [] }) };
      }),
      findApprovalForPayload: vi.fn(async(key: string, value: string) => decision?.payload?.[key] === value ? decision : undefined),
    };
    const upstream = vi.fn(async() => ({ status: 200, headers: {}, body: {} }));
    const approvalContext = {
      selectedEnvironment: 'production',
      effectiveEnvironment: 'production',
      instanceId: 'ins_live',
      method: 'DELETE',
      path: '/v1/users/user_fixture',
      query: '',
      options: {},
      action: deleteTool, requesterAgentId: f.context.agent_id,
      jobId: f.context.job_id ?? null, threadId: f.context.thread_id ?? null, changes: {},
    };
    const broker = {
      requestFor: vi.fn((_execution: ToolExecutionContext, input: Record<string, unknown>) => input),
      execute: vi.fn(async(request: unknown) => {
        throw new VaultApprovalRequiredError(operationId, request as any, 'Vault approval is required', approvalContext as any);
      }),
      integrationMetadata: vi.fn(),
    };
    const authorize = vi.fn(() => Promise.resolve('approval-id'));
    const client = new ClerkClient({
      broker: broker as any,
      authorize,
      decisions,
      context: async caller => {
        const execution = caller.revalidate ? await caller.revalidate() : caller.execution;
        if (!execution) throw new Error('Missing trusted execution context');
        return { ...execution, credential_scope: { integration_id: 'clerk', account_id: 'default' } };
      },
    });
    const worker = { bindClerkCaller: vi.fn() } as any;
    try {
      await f.resolver.bindForwarded(worker, deleteTool, f.session.id, f.context, new AbortController().signal);
      const caller = worker.bindClerkCaller.mock.calls[0]?.[0] as ClerkCaller;
      const args = { user_id: 'user_fixture', environment: 'production', confirm: true };
      const pending = await client.named('delete_user', args, caller) as { status: string; operationId: string };
      expect(pending).toEqual({ status: 'approval_pending', operationId });
      expect(decisions.request).toHaveBeenCalledTimes(1);
      expect(broker.execute).toHaveBeenCalledTimes(1);

      decision = { ...decision, status: 'approved' };
      f.session.revoke();
      await expect(client.named('delete_user', { ...args, operationId }, caller))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining(CLERK_CONTAINER_DENIAL) });
      expect(authorize).not.toHaveBeenCalled();
      expect(broker.execute).toHaveBeenCalledTimes(1);
      expect(upstream).not.toHaveBeenCalled();
      expect(f.issueLocalBrokerContext).toHaveBeenCalledTimes(2);
    } finally { await f.release(); }
  });

  it.each([
    ['missing session id', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: undefined, context: f.context })],
    ['missing forwarded context', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: undefined })],
    ['unverified issuer', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, iss: 'untrusted' } })],
    ['unverified audience', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, aud: 'other' } })],
    ['forwarded scope excludes the tool', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, scopes: ['clerk_list_users'] } })],
    ['generation mismatch', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, tool_session_generation: 'other-generation' } })],
    ['task mismatch', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, task_index: binding.taskIndex + 1 } })],
    ['expired forwarded context', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, exp: Math.floor(Date.now() / 1_000) - 1 } })],
    ['pod mismatch', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, pod_id: 'other-pod' } })],
    ['agent mismatch', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, agent_id: 'other-agent' } })],
    ['job mismatch', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, job_id: 'other-job' } })],
    ['thread mismatch', (f: Awaited<ReturnType<typeof fixture>>) => ({ sessionId: f.session.id, context: { ...f.context, thread_id: 'other-thread' } })],
  ])('refuses %s before issuing vault context', async(_label, makeInput) => {
    const f = await fixture();
    const input = makeInput(f) as { sessionId: unknown; context?: ToolExecutionContext };
    try {
      await expect(f.resolver.bindForwarded(f.worker, name, input.sessionId, input.context, new AbortController().signal))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining(CLERK_CONTAINER_DENIAL) });
      expect(f.issueLocalBrokerContext).not.toHaveBeenCalled();
      expect(f.worker.bindClerkCaller).not.toHaveBeenCalled();
    } finally { await f.release(); }
  });

  it('refuses disallowed tools, expired sessions, stopped sessions, and same-state rebinds', async() => {
    const denied = await fixture({ allowed: ['clerk_list_users'] });
    try {
      await expect(denied.resolver.bindForwarded(denied.worker, name, denied.session.id, denied.context, new AbortController().signal))
        .rejects.toMatchObject({ status: 403 });
      expect(denied.issueLocalBrokerContext).not.toHaveBeenCalled();
    } finally { await denied.release(); }

    const expired = await fixture();
    try {
      expired.host.peekToolSession(expired.session.id)!.expiresAt = Date.now() - 1;
      await expect(expired.resolver.bindForwarded(expired.worker, name, expired.session.id, expired.context, new AbortController().signal))
        .rejects.toMatchObject({ status: 403 });
      expect(expired.issueLocalBrokerContext).not.toHaveBeenCalled();
    } finally { await expired.release(); }

    const stopped = await fixture();
    try {
      await stopped.resolver.bindForwarded(stopped.worker, name, stopped.session.id, stopped.context, new AbortController().signal).catch(() => {});
      const caller = stopped.worker.bindClerkCaller.mock.calls[0]?.[0] as ClerkCaller | undefined;
      stopped.session.revoke();
      await expect(caller?.revalidate?.()).rejects.toMatchObject({ status: 403 });
      expect(stopped.issueLocalBrokerContext).toHaveBeenCalledTimes(1);
    } finally { await stopped.release(); }

    const rebound = await fixture();
    try {
      await rebound.host.rebindSession(rebound.session.id, rebound.state, 60_000, binding);
      await expect(rebound.resolver.bindForwarded(rebound.worker, name, rebound.session.id, rebound.context, new AbortController().signal))
        .rejects.toMatchObject({ status: 403 });
      expect(rebound.issueLocalBrokerContext).not.toHaveBeenCalled();
    } finally { await rebound.release(); }

    const reboundToOtherState = await fixture();
    try {
      await reboundToOtherState.host.rebindSession(reboundToOtherState.session.id,
        { metadata: { agentId: 'other-agent', threadId: 'other-thread', allowedToolNames: [name] } } as any, 60_000, binding);
      await expect(reboundToOtherState.resolver.bindForwarded(reboundToOtherState.worker, name,
        reboundToOtherState.session.id, reboundToOtherState.context, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
      expect(reboundToOtherState.issueLocalBrokerContext).not.toHaveBeenCalled();
    } finally { await reboundToOtherState.release(); }

    const mismatchedSession = await fixture();
    try {
      const otherBinding = { ...binding, podId: 'other-pod', jobId: 'other-job', agentId: 'other-agent', threadId: 'other-thread' };
      const otherState = { metadata: { agentId: otherBinding.agentId, threadId: otherBinding.threadId, allowedToolNames: [name] } } as any;
      const otherSession = mismatchedSession.host.registerSession(otherState, 60_000, otherBinding);
      await expect(mismatchedSession.resolver.bindForwarded(mismatchedSession.worker, name, otherSession.id,
        mismatchedSession.context, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
      expect(mismatchedSession.issueLocalBrokerContext).not.toHaveBeenCalled();
      otherSession.revoke();
    } finally { await mismatchedSession.release(); }
  });

  it('refuses a session whose pod is no longer registered with Desktop', async() => {
    const f = await fixture();
    f.unregister();
    try {
      await expect(f.resolver.bindForwarded(f.worker, name, f.session.id, f.context, new AbortController().signal))
        .rejects.toMatchObject({ status: 403 });
      expect(f.issueLocalBrokerContext).not.toHaveBeenCalled();
    } finally { await f.release(); }
  });

  it('refuses a Desktop binding whose task index differs from the forwarded lease', async() => {
    const f = await fixture();
    const mismatchedRegistry = new AgentContainerRuntimeRegistry();
    const unregisterMismatched = mismatchedRegistry.register({ ...binding, taskIndex: binding.taskIndex + 1 });
    const resolver = new ClerkToolSessionResolver(f.host, { issueLocalBrokerContext: f.issueLocalBrokerContext },
      () => 'installation-token', new AgentAwarenessPolicy(), Date.now, mismatchedRegistry);
    try {
      await expect(resolver.bindForwarded(f.worker, name, f.session.id, f.context, new AbortController().signal))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining(CLERK_CONTAINER_DENIAL) });
      expect(f.issueLocalBrokerContext).not.toHaveBeenCalled();
      expect(f.worker.bindClerkCaller).not.toHaveBeenCalled();
    } finally {
      unregisterMismatched();
      await f.release();
    }
  });

  it.each(['expired session', 'revoked tool allow list', 'removed live binding'] as const)(
    'revalidates the %s before issuing a refreshed vault context', async change => {
      const f = await fixture();
      try {
        await f.resolver.bindForwarded(f.worker, name, f.session.id, f.context, new AbortController().signal);
        const caller = f.worker.bindClerkCaller.mock.calls[0]?.[0] as ClerkCaller;
        if (change === 'expired session') f.host.peekToolSession(f.session.id)!.expiresAt = Date.now() - 1;
        if (change === 'revoked tool allow list') f.state.metadata.allowedToolNames = [];
        if (change === 'removed live binding') f.unregister();
        await expect(caller.revalidate?.()).rejects.toMatchObject({ status: 403, message: expect.stringContaining(CLERK_CONTAINER_DENIAL) });
        expect(f.issueLocalBrokerContext).toHaveBeenCalledTimes(1);
      } finally { await f.release(); }
    });

  it('refuses inventory-only container survivors after registry rehydration', async() => {
    const inventoryRegistry = new AgentContainerRuntimeRegistry({ liveBindings: async() => [{ ...binding, origin: 'inventory' }] });
    await inventoryRegistry.rehydrate();
    const f = await fixture({ registry: inventoryRegistry, register: false });
    try {
      await expect(f.resolver.bindForwarded(f.worker, name, f.session.id, f.context, new AbortController().signal))
        .rejects.toMatchObject({ status: 403 });
      expect(f.issueLocalBrokerContext).not.toHaveBeenCalled();
    } finally { await f.release(); }
  });
});
