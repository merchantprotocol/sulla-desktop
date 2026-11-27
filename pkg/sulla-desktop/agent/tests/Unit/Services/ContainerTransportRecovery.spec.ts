// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { AgentAwarenessPolicy } from '../../../services/AgentAwarenessPolicy';
import { createAgentContainerLifecycle, runAgentContainer, resetAgentContainerImageResolution, GuestAgentContainerRuntimeSupervisor } from '../../../services/AgentContainerLauncher';
import { agentContainerRuntimeRegistry, AgentContainerRuntimeRegistry, ContainerExecutionContextFactory } from '../../../services/AgentContainerRuntimeRegistry';
import { ContainerSessionLeases } from '../../../services/ContainerSessionLeases';
import { toolSessionOrigin } from '../../../services/ToolSessionOrigin';
import { BaseTool } from '../../../tools/base';
import { ClerkWorker } from '../../../tools/clerk/ClerkWorker';
import { clerkToolManifests } from '../../../tools/clerk/manifests';
import { toolRegistry } from '../../../tools/registry';
import { toolDecisionPort } from '../../../tools/toolDecisionPort';
import * as runner from '../../../tools/util/CommandRunner';

import { ClerkToolSessionResolver } from '@pkg/main/ClerkToolSessionResolver';
import { getMCPServerHost } from '@pkg/main/MCPServerHost';
import { deriveCapabilitySigningKey, verifyCapabilityToken, issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import { configuredVaultBrokerProvider } from '@pkg/vault-broker';

import type { BaseThreadState } from '../../../nodes/Graph';

const edges = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: edges.spawn }));
vi.mock('electron', () => ({ default: { app: { getVersion: () => 'test', getPath: () => '/tmp' } } }));
vi.mock('@pkg/main/chatCompletionsServer', () => ({ getChatCompletionsServer: () => ({ getApiToken: () => 'fixture-desktop' }) }));
vi.mock('@pkg/backend/sullaServiceImages', () => ({ resolveSullaServiceImage: () => ({ image: 'fixture:v1' }), shouldRefreshSullaServiceImage: () => false }));
vi.mock('@pkg/main/sullaFilesMountManager', () => ({ getSullaFilesMountManager: () => ({ guestMountAvailable: () => false }) }));
vi.mock('@pkg/main/threat-proxy', () => ({ egressEnforced: async() => false, applyCurrentEgressPolicy: async() => {} }));
vi.mock('@pkg/agent/utils/sullaPaths', async original => ({ ...await original<object>(), resolveMemorySeedDir: () => '/fixture/seed' }));
vi.mock('../../../services/GuestRuntimeTransport', async original => ({ ...await original<object>(),
  getGuestRuntimeIdentity: async() => ({ uid: 1000, gid: 1000 }), createGuestRuntimeDirectory: async() => '/fixture/work',
  seedContentAddressedDirectoryIntoGuest: async() => '/fixture/memory', seedDirectoryIntoGuest: async() => '/fixture/memory',
  chownGuestPaths: async() => {}, removeGuestPathAtomic: async() => {}, inspectGuestWorkspaceForCleanup: async() => ({ remove: true }),
}));
vi.mock('../../../services/GuestWorkspaceClaim', () => ({ claimGuestWorkspace: async() => ({ release: async() => {} }) }));
vi.mock('../../../services/ContainerProviderFileTransport', () => ({
  ContainerProviderFileTransport: { create: async() => ({ bindMount: 'fixture', dispose: async() => {} }) },
}));
vi.mock('@pkg/vault-broker', async original => ({ ...await original<object>(), usesContainerVaultAuthority: () => false }));
vi.mock('../../../database/models/WorkFileClaimModel', () => ({ WorkFileClaimModel: { listActive: async() => [] } }));
vi.mock('../../../database/RedisClient', () => ({ redisClient: { set: async() => {} } }));

const binding = { podId: 'sulla-agent-clock-0', subject: 'owner', agentId: 'agent', threadId: 'thread', jobId: 'clock',
  taskIndex: 0, deviceId: 'device', workspacePath: '/fixture/work' };
const state = { metadata: { agentId: 'agent', threadId: 'thread', deviceId: 'device', userId: 'owner',
  allowedToolNames: ['meta/ping', 'clerk_get_user'] } } as BaseThreadState;
const key = deriveCapabilitySigningKey('fixture-desktop');
const host = getMCPServerHost();
const worker = () => { const w = new ClerkWorker(); w.name = 'clerk_get_user'; return w; };
const unexpectedBroker = vi.fn(() => Promise.reject(new Error('unexpected broker admission')));
const resolver = new ClerkToolSessionResolver(host, { issueLocalBrokerContext: unexpectedBroker },
  () => null, new AgentAwarenessPolicy());

function liveLauncher() {
  const issuer = new ContainerSessionLeases(binding, host, ['clerk_get_user'], 'fixture', key, 60_000,
    { replace: () => Promise.resolve(), remove: () => Promise.resolve() });
  const unregister = agentContainerRuntimeRegistry.register(binding, issuer);
  const launcher = host.registerSession(state, 60_000, binding);
  return { issuer, unregister, launcher };
}

// Check authorization decisions only; these fixtures never dispatch a Clerk request.
const clerkAllowed = (id: string) => resolver.resolveSession(id, 'clerk_get_user', new AbortController().signal, state)
  .then(() => true, error => { if (error.status !== 403) throw error; return false; });

describe('session registration authority', () => {
  it.each(['projected', 'direct', 'nested direct', 'missing lease', 'invalid signature', 'wrong generation', 'signed forwarded'] as const)(
    'checks %s on a registered live v2 session', async route => {
      const port = host['port']; host['port'] = 1;
      const name = 'clerk_get_user';
      const { issuer, unregister, launcher } = liveLauncher();
      const session = host.peekToolSession(launcher.id)!;
      const broker = vi.spyOn(configuredVaultBrokerProvider, 'issueLocalBrokerContext').mockResolvedValue(session.executionContext!);
      const policy = new ClerkToolSessionResolver(host, configuredVaultBrokerProvider, () => null, new AgentAwarenessPolicy());
      const signal = new AbortController().signal;
      try {
        expect(session.transportVersion).toBe('2');
        expect(session.clerk).toBe('ordinary');
        const signed = issuer.issue(launcher.id);
        const verify = (token: string) => verifyCapabilityToken(token, key, { category: 'clerk', tool: name });
        const claims = await verify(signed);
        expect(claims.tool_session_generation).toBe(session.executionContext!.jti);
        const forwarded = async(token: string) => policy.bindForwarded(worker(), name, launcher.id,
          { ...await verify(token), request_id: 'fixture' }, signal);

        if (route === 'projected') {
          if (!toolRegistry.isRegistered(name)) toolRegistry.registerManifests(clerkToolManifests);
          const createWorker = vi.spyOn(toolRegistry, 'createTool');
          const server = host['buildMcpServer'](session);
          const client = new Client({ name: 'fixture', version: '1' });
          const [local, peer] = InMemoryTransport.createLinkedPair();
          try {
            await server.connect(peer);
            await client.connect(local);
            const result = await client.callTool({ name: 'sulla_tool', arguments: { tool: name, args: {} } });
            expect(createWorker).not.toHaveBeenCalled();
            expect(broker).not.toHaveBeenCalled();
            expect(result.isError).toBe(true);
            expect(result.content).toEqual([{ type: 'text', text: "Clerk isn't available to restricted-tool agents in containers; use the main chat or an agent with normal tools" }]);
          } finally { createWorker.mockRestore(); await client.close(); await server.close() }
        } else if (route === 'signed forwarded') {
          await forwarded(signed);
        } else if (route === 'missing lease') {
          await expect(policy.bindForwarded(worker(), name, launcher.id, undefined, signal)).rejects.toMatchObject({ status: 403 });
        } else if (route === 'invalid signature') {
          const otherKey = deriveCapabilitySigningKey('fixture-other-install');
          const token = issueCapabilityToken({ ...claims, expiresInSeconds: 60 }, otherKey);
          await expect(forwarded(token)).rejects.toMatchObject({ code: 'invalid', message: 'Invalid capability signature' });
        } else if (route === 'wrong generation') {
          host.rebindSession(launcher.id, state, 60_000, binding);
          await expect(forwarded(signed)).rejects.toMatchObject({ status: 403 });
        } else {
          const direct = () => policy.resolve({ headers: { authorization: launcher.header } }, name, signal);
          await expect(route === 'nested direct' ? toolSessionOrigin.withinTool(direct) : direct())
            .rejects.toMatchObject({ status: 403, message: 'clerk_container_isolation_unavailable' });
        }
        expect(broker).toHaveBeenCalledTimes(route === 'signed forwarded' ? 1 : 0);
      } finally { broker.mockRestore(); launcher.revoke(); unregister(); await issuer.close(); host['port'] = port }
    });

  it('does not trust a legacy server-side pair or a local marker on a container execution context', async() => {
    const port = host['port']; host['port'] = 1;
    const { issuer, unregister, launcher } = liveLauncher();
    unexpectedBroker.mockClear();
    try {
      const record = host.peekToolSession(launcher.id)!;
      expect(record.transportVersion).toBe('2');
      const pair = { generation: record.executionContext!.jti, expiresAt: record.expiresAt };
      for (const marker of [pair, 'local']) {
        Object.assign(record, { clerk: marker }); // Simulate a pre-deny record, not request metadata.
        await expect(resolver.resolveSession(launcher.id, 'clerk_get_user', new AbortController().signal))
          .rejects.toThrow('clerk_container_isolation_unavailable');
      }
      expect(unexpectedBroker).not.toHaveBeenCalled();
    } finally { launcher.revoke(); unregister(); await issuer.close(); host['port'] = port }
  });

  it('allows a host-local root, but a container rebind permanently removes its Clerk authority', async() => {
    const port = host['port']; host['port'] = 1;
    const root = host.registerSession(state, 60_000);
    const proof = new ContainerExecutionContextFactory().create(state, 60_000, { ...binding, podId: 'desktop-main' })!;
    const local = { issueLocalBrokerContext: vi.fn(async() => proof) };
    const policy = new ClerkToolSessionResolver(host, local, () => null, new AgentAwarenessPolicy());
    const resolve = () => policy.resolveSession(root.id, 'clerk_get_user', new AbortController().signal);
    try {
      const caller = await resolve();
      expect(caller.execution?.pod_id).toBe('desktop-main');
      host.rebindSession(root.id, state, 60_000, binding);
      expect(caller.signal?.aborted).toBe(true);
      await expect(caller.revalidate!()).rejects.toMatchObject({ status: 403, message: 'The Clerk session authorization expired.' });
      await expect(resolve()).rejects.toThrow('clerk_container_isolation_unavailable');
      host.rebindSession(root.id, state, 60_000);
      await expect(resolve()).rejects.toThrow('clerk_container_isolation_unavailable');
      expect(local.issueLocalBrokerContext).toHaveBeenCalledTimes(1);
    } finally { root.revoke(); host['port'] = port; }
  });

  it('keeps tool-created MCP sessions and their descendants ordinary even with a live issuer', async() => {
    const port = host['port']; host['port'] = 1;
    const { issuer, unregister, launcher } = liveLauncher();
    unexpectedBroker.mockClear();
    const created: ReturnType<typeof host.registerSession>[] = [];
    class RegisterChild extends BaseTool {
      name = 'fixture'; description = '';
      protected async _validatedCall() {
        const child = host.registerSession(state, 60_000, binding);
        created.push(child);
        await issuer.prepare(child.id);
        return { successBoolean: true, responseString: 'registered' };
      }
    }
    const decisions = vi.spyOn(toolDecisionPort.resolve(), 'requiresApproval').mockResolvedValue(false);
    try {
      const parent = await verifyCapabilityToken(issuer.issue(launcher.id), key, { category: 'clerk', tool: 'clerk_get_user' });
      const register = new RegisterChild();
      for (let depth = 0; depth < 2; depth++) {
        if (depth) register.executionContext = host.peekToolSession(created[0].id)!.executionContext;
        expect((await register.invoke({}, state)).success).toBe(true);
      }
      expect(created.map(child => host.peekToolSession(child.id)?.transportVersion)).toEqual(['2', '2']);
      expect(await Promise.all(created.map(child => clerkAllowed(child.id)))).toEqual([false, false]);
      const child = created[0];
      const signal = new AbortController().signal;
      const ctx = host.peekToolSession(child.id)!.executionContext!;
      await expect(resolver.resolve({ headers: { authorization: child.header } }, 'clerk_get_user', signal)).rejects.toMatchObject({ status: 403 });
      await expect(resolver.bindForwarded(worker(), 'clerk_get_user', child.id, { ...parent, request_id: 'fixture' }, signal))
        .rejects.toMatchObject({ status: 403 });
      // Retain the original no-live-registration denial, even when the graph labels still match.
      unregister();
      await expect(resolver.bindForwarded(worker(), 'clerk_get_user', child.id, { ...ctx, tool_session_generation: ctx.jti }, signal))
        .rejects.toMatchObject({ status: 403 });
      // A host-side rebind cannot promote this child into an eligible local graph.
      host.rebindSession(child.id, state, 60_000);
      expect(await clerkAllowed(child.id)).toBe(false);
      expect(await clerkAllowed(launcher.id)).toBe(false);
      expect(unexpectedBroker).not.toHaveBeenCalled();
    } finally {
      unregister(); decisions.mockRestore(); created.forEach(child => child.revoke());
      launcher.revoke(); await issuer.close(); host['port'] = port;
    }
  });
});

// Only the guest subprocess/clock are simulated; the launcher, registry and lease issuer are real.
function guestLauncher(version: '1' | '2') {
  const files = new Map<string, string>();
  let created = false;
  let detach: (() => void) | undefined;
  let notifyAttached!: () => void;
  const attached = new Promise<void>(resolve => { notifyAttached = resolve });
  resetAgentContainerImageResolution();
  vi.stubEnv('SULLA_AGENT_IMAGE', 'fixture:v1');
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({})));
  edges.spawn.mockImplementation((_cmd, argv: string[]) => {
    const p = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const args = argv.slice(2);
    if (args.includes('sulla-container-secrets')) {
      p.stdin.on('data', chunk => {
        for (const line of String(chunk).trimEnd().split('\n')) {
          const [name, value] = line.split('\t'); files.set(name, Buffer.from(value, 'base64').toString());
        }
      });
    }
    if (args[0] === 'python3' && args[3]?.endsWith('/SULLA_API_TOKEN')) {
      p.stdin.on('data', chunk => files.set('SULLA_API_TOKEN', String(chunk)));
    }
    if (args.includes('--attach')) {
      p.stdin.once('data', notifyAttached);
      detach = () => p.emit('close', 0);
      return p;
    }
    queueMicrotask(() => {
      if (args.slice(0, 3).join(' ') === 'docker image inspect' && args[3] === 'fixture:v1') {
        p.stdout.write(JSON.stringify([{ Id: 'sha256:' + '1'.repeat(64), Config: { Labels: { 'com.sulla.agent.transport-version': version } } }]));
      } else if (args[0] === 'docker' && args[1] === 'create') {
        created = args.includes('sha256:' + '1'.repeat(64)) || args.includes('fixture:v1');
        p.stdout.write('a'.repeat(64));
      } else if (version === '1' && args[2]?.includes('files-fuse/actors;')) {
        p.emit('close', 1); return;
      } else if (args[0] === 'docker' && args[1] === 'inspect') {
        p.stdout.write(JSON.stringify([{ State: { Running: true } }]));
      }
      p.emit('close', 0);
    });
    return p;
  });
  return { files, attached, detach: () => detach?.(), created: () => created };
}

describe('launcher compatibility', () => {
  it.each([['persistent', createAgentContainerLifecycle], ['standalone', runAgentContainer]] as const)(
    'creates a %s container on a v1-only image with an ordinary, non-Clerk capability', async(_kind, launch) => {
      const { files, created } = guestLauncher('1');
      const port = host['port']; host['port'] = 1;
      try {
        const failure = await launch({ kind: 'chat', jobId: 'clock', taskIndex: 0, state, provider: 'codex', instructions: 'fixture' } as never)
          .then(() => '', (error: Error) => error.message);
        expect(created(), failure).toBe(true);
        const proof = await verifyCapabilityToken(files.get('SULLA_API_TOKEN'), key, { category: 'meta', tool: 'ping' });
        expect(proof.tool_session_generation).toBeUndefined();
        await expect(resolver.bindForwarded(worker(), 'clerk_get_user', files.get('SULLA_TOOL_SESSION'),
          { ...proof, request_id: 'fixture' }, new AbortController().signal)).rejects.toThrow('clerk_container_isolation_unavailable');
      } finally { host['port'] = port; vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetAgentContainerImageResolution(); }
    });
});

describe('launcher default transport ownership', () => {
  it.each(['persistent', 'standalone'] as const)('keeps the %s verified v2 default at launch and on real timer renewal', async kind => {
    const guest = guestLauncher('2');
    const port = host['port']; host['port'] = 1;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const run = { kind: 'chat' as const, jobId: 'clock', taskIndex: 0, state, provider: 'codex', instructions: 'fixture', prompt: 'fixture' };
    let lifecycle: Awaited<ReturnType<typeof createAgentContainerLifecycle>> | undefined;
    let standalone: ReturnType<typeof runAgentContainer> | undefined;
    try {
      if (kind === 'persistent') lifecycle = await createAgentContainerLifecycle(run);
      else {
        standalone = runAgentContainer(run);
        await Promise.race([guest.attached, standalone.then(() => { throw new Error('container exited before attachment') })]);
      }
      const id = guest.files.get('SULLA_TOOL_SESSION')!;
      const verified = () => verifyCapabilityToken(guest.files.get('SULLA_API_TOKEN'), key, { category: 'clerk', tool: 'clerk_get_user' });
      const first = await verified();
      expect(host.peekToolSession(id)?.transportVersion).toBe('2');
      expect(host.peekToolSession(id)?.executionContext?.jti).toBe(first.tool_session_generation);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const fresh = await verified();
      expect(fresh.tool_session_generation).not.toBe(first.tool_session_generation);
      expect(host.peekToolSession(id)?.executionContext?.jti).toBe(fresh.tool_session_generation);
      expect(host.peekToolSession(id)?.transportVersion).toBe('2');

      // A different verified v2 issuer owns its own default, not this one.
      const original = agentContainerRuntimeRegistry.require({ ...fresh, request_id: 'fixture' });
      const other = { ...binding }; // Replacement at the same pod, including identical identity labels.
      const issuer = new ContainerSessionLeases(other, host, ['meta/ping'], 'other', key, 60_000,
        { replace: () => Promise.resolve(), remove: () => Promise.resolve() });
      const unregister = agentContainerRuntimeRegistry.register(other, issuer);
      const otherDefault = host.registerSession(state, 60_000, other);
      try {
        issuer.issue(otherDefault.id);
        host.rebindSession(id, state, 60_000, other);
        expect(host.peekToolSession(id)?.transportVersion).toBeUndefined();
        host.rebindSession(id, state, 60_000, original);
        expect(host.peekToolSession(id)?.transportVersion).toBeUndefined();
      } finally { otherDefault.revoke(); unregister(); await issuer.close() }
      // A copy of the labels does not own this session.
      host.rebindSession(id, state, 60_000, { ...binding });
      expect(host.peekToolSession(id)?.transportVersion).toBeUndefined();
    } finally {
      guest.detach();
      try { await standalone; await lifecycle?.close() } finally {
        host['port'] = port; vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetAgentContainerImageResolution();
      }
    }
  });
});

describe('owned lease renewal', () => {
  it('recovers a swept default after 16 minutes without reviving a provider, revoked launcher, or Clerk authority', async() => {
    const clock = vi.spyOn(Date, 'now'); const start = Date.now();
    const port = host['port']; host['port'] = 1;
    const files = new Map<string, string>();
    const leases = new ContainerSessionLeases(binding, host, ['meta/ping', 'clerk_get_user'], 'fixture', key, 900_000,
      { replace: async(n, v) => { files.set(n, v); }, remove: async n => { files.delete(n); } });
    const a = host.registerSession(state, 900_000, binding);
    const b = host.registerSession(state, 900_000, binding);
    const renew = () => leases.renew(a.id, () => host.rebindSession(a.id, state, 900_000, binding));
    try {
      const proof = { ...await verifyCapabilityToken(leases.issue(a.id), key), request_id: 'held' };
      const held = worker();
      await expect(resolver.bindForwarded(held, held.name, a.id, proof, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
      await leases.prepare(b.id);
      expect(host.peekToolSession(b.id)?.clerk).toBe('ordinary');
      expect(await clerkAllowed(b.id)).toBe(false);
      b.revoke();
      clock.mockReturnValue(start + 960_000);
      expect(host.peekToolSession(a.id)).toBeNull(); // Sweep before timer callback.
      await renew();
      const fresh = await verifyCapabilityToken(files.get('SULLA_API_TOKEN'), key, { category: 'meta', tool: 'ping' });
      expect(fresh.tool_session_generation).toBe(host.peekToolSession(a.id)?.executionContext?.jti);
      expect(fresh.tool_session_generation).not.toBe(proof.tool_session_generation);
      expect(host.peekToolSession(b.id)).toBeNull();
      expect(await clerkAllowed(a.id)).toBe(false);
      a.revoke(); await expect(renew()).rejects.toThrow();
      expect(host.peekToolSession(a.id)).toBeNull();
    } finally { a.revoke(); b.revoke(); await leases.close(); clock.mockRestore(); host['port'] = port; }
  });
});

async function inventory(scoped: boolean) {
  const lifecycle = 'a6d55df4-acbf-412d-baea-b91ee1f24a2a';
  const directory = '/dev/shm/sulla-agent-secrets/' + binding.podId + '-' + lifecycle;
  const runtime = { list: async() => [{ ID: 'a'.repeat(64) }], inspect: async() => ({ Name: '/' + binding.podId,
    State: { Running: true }, Mounts: [{ Type: 'bind', Destination: '/run/secrets/sulla-agent', Source: directory }],
    Config: { WorkingDir: binding.workspacePath, User: '1000:1000', Labels: {
      ...(scoped ? { 'com.sulla.capability-scopes': JSON.stringify(['meta/ping', 'clerk_get_user']) } : {}),
      'com.sulla.agent.transport-version': '2', 'com.sulla.workload': 'agent', 'com.sulla.capability-jti': lifecycle,
      'com.sulla.job-id': binding.jobId, 'com.sulla.task-index': '0', 'com.sulla.subject': binding.subject,
      'com.sulla.agent-id': binding.agentId, 'com.sulla.thread-id': binding.threadId, 'com.sulla.device-id': binding.deviceId,
    } } }) };
  const registry = new AgentContainerRuntimeRegistry(new GuestAgentContainerRuntimeSupervisor(runtime as never));
  const parent = { ...await verifyCapabilityToken(issueCapabilityToken({ sub: binding.subject, pod_id: binding.podId,
    agent_id: binding.agentId, job_id: binding.jobId, task_index: 0, thread_id: binding.threadId, device_id: binding.deviceId,
    jti: lifecycle, tool_session_generation: 'old', scopes: ['meta/ping', 'clerk_get_user'], expiresInSeconds: 120 }, key), key), request_id: 'fixture' };
  return { lifecycle, directory, registry, parent };
}

describe('cold container inventory', () => {
  // Restart ownership (#2944): a container that outlived its Desktop has no live MCP session,
  // provider bridge or renewal owner, so it must not run agent-local work anywhere, including the VM.
  it.each([false, true])('refuses agent-local dispatch for a recovered container (persisted scopes: %s)', async scoped => {
    const { registry, parent } = await inventory(scoped);
    await registry.rehydrate();
    const guest = vi.spyOn(runner, 'runCommand');
    try {
      const git = { ...parent, scopes: ['github/git_status'], credential_scope: { integration_id: 'github', account_id: 'fixture' } };
      for (const ctx of [parent, git]) {
        expect(() => registry.require(ctx)).toThrow(expect.objectContaining({ reason: 'container_owner_not_rehydrated' }));
        expect(() => registry.forExecution(ctx, 'agent-local')).toThrow(expect.objectContaining({ reason: 'container_owner_not_rehydrated' }));
        expect(() => registry.forForwardedExecution(ctx, 'agent-local')).toThrow(expect.objectContaining({ reason: 'container_owner_not_rehydrated' }));
      }
      expect(registry.probe(binding.jobId, binding.threadId, 'desktop')).toBe(false);
      expect(guest).not.toHaveBeenCalled();
    } finally { guest.mockRestore(); }
  });
});
