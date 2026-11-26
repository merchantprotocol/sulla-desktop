// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as runner from '../../../tools/util/CommandRunner';
import { BaseTool } from '../../../tools/base';
import { toolDecisionPort } from '../../../tools/toolDecisionPort';
import { GitStatusWorker } from '../../../tools/github/git_status';
import { ExecWorker } from '../../../tools/meta/exec';
import { AgentContainerRuntimeRegistry, agentContainerRuntimeRegistry } from '../../../services/AgentContainerRuntimeRegistry';
import { ContainerSessionLeases } from '../../../services/ContainerSessionLeases';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { BaseThreadState } from '../../../nodes/Graph';
import { deriveCapabilitySigningKey, verifyCapabilityToken, issueCapabilityToken } from '@pkg/runtime/capabilityToken';
import { getMCPServerHost } from '@pkg/main/MCPServerHost';
import { ClerkToolSessionResolver } from '@pkg/main/ClerkToolSessionResolver';
import { AgentAwarenessPolicy } from '../../../services/AgentAwarenessPolicy';
import { ClerkWorker } from '../../../tools/clerk/ClerkWorker';
import { createAgentContainerLifecycle, runAgentContainer, resetAgentContainerImageResolution, GuestAgentContainerRuntimeSupervisor } from '../../../services/AgentContainerLauncher';

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
const resolver = new ClerkToolSessionResolver(host, { issueLocalBrokerContext: async() => { throw Error('unexpected fallback'); } },
  () => null, new AgentAwarenessPolicy());

// Check authorization decisions only; these fixtures never dispatch a Clerk request.
const clerkAllowed = (id: string) => resolver.resolveSession(id, 'clerk_get_user', new AbortController().signal, state)
  .then(() => true, error => { if (error.status !== 403) throw error; return false; });

describe('session registration authority', () => {
  it('admits a paired launcher and provider only while their original pair is live', async() => {
    const port = host['port']; host['port'] = 1;
    const issuer = new ContainerSessionLeases(binding, host, ['clerk_get_user'], 'fixture', key, 60_000,
      { replace: async() => {}, remove: async() => {} });
    const launcher = host.registerSession(state, 60_000, binding);
    const provider = host.registerSession(state, 60_000, binding);
    try {
      expect(await clerkAllowed(launcher.id)).toBe(false);
      issuer.issue(launcher.id);
      await issuer.prepare(provider.id);
      expect(await clerkAllowed(launcher.id)).toBe(true);
      expect(await clerkAllowed(provider.id)).toBe(true);
      launcher.revoke();
      expect(await clerkAllowed(provider.id)).toBe(false);
    } finally { launcher.revoke(); provider.revoke(); await issuer.close(); host['port'] = port; }
  });

  it('keeps tool-created MCP sessions and their descendants ordinary even with a live issuer', async() => {
    const port = host['port']; host['port'] = 1;
    const issuer = new ContainerSessionLeases(binding, host, ['clerk_get_user'], 'fixture', key, 60_000,
      { replace: async() => {}, remove: async() => {} });
    const launcher = host.registerSession(state, 60_000, binding);
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
      issuer.issue(launcher.id);
      const register = new RegisterChild();
      for (let depth = 0; depth < 2; depth++) {
        if (depth) register.executionContext = host.peekToolSession(created[0].id)!.executionContext;
        expect((await register.invoke({}, state)).success).toBe(true);
      }
      expect(await Promise.all(created.map(child => clerkAllowed(child.id)))).toEqual([false, false]);
      expect(await clerkAllowed(launcher.id)).toBe(true);
    } finally { decisions.mockRestore(); created.forEach(child => child.revoke()); launcher.revoke(); await issuer.close(); host['port'] = port; }
  });
});

describe('launcher compatibility', () => {
  it.each([['persistent', createAgentContainerLifecycle], ['standalone', runAgentContainer]] as const)(
    'creates a %s container on a v1-only image with an ordinary, non-Clerk capability', async(_kind, launch) => {
      const files = new Map<string, string>();
      let created = false;
      const port = host['port']; host['port'] = 1;
      resetAgentContainerImageResolution();
      vi.stubEnv('SULLA_AGENT_IMAGE', 'fixture:v1');
      vi.stubGlobal('fetch', async() => Response.json({}));
      edges.spawn.mockImplementation((_cmd, argv: string[]) => {
        const p = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        const args = argv.slice(2); const op = args.slice(0, 3).join(' ');
        if (args.includes('sulla-container-secrets')) p.stdin.on('data', chunk => {
          for (const line of String(chunk).trimEnd().split('\n')) {
            const [name, value] = line.split('\t'); files.set(name, Buffer.from(value, 'base64').toString());
          }
        });
        queueMicrotask(() => {
          if (op === 'docker image inspect' && args[3] === 'fixture:v1') {
            p.stdout.write(JSON.stringify([{ Id: 'sha256:' + '1'.repeat(64), Config: { Labels: { 'com.sulla.agent.transport-version': '1' } } }]));
          } else if (args[0] === 'docker' && args[1] === 'create') {
            created = args.includes('sha256:' + '1'.repeat(64)) || args.includes('fixture:v1'); p.stdout.write('a'.repeat(64));
          } else if (args[2]?.includes('files-fuse/actors;')) {
            // Stop after successful creation. Both launchers exercise their normal cleanup.
            p.emit('close', 1); return;
          }
          p.emit('close', 0);
        });
        return p;
      });
      try {
        const failure = await launch({ jobId: 'clock', taskIndex: 0, state, provider: 'codex', instructions: 'fixture' } as never)
          .then(() => '', (error: Error) => error.message);
        expect(created, failure).toBe(true);
        const proof = await verifyCapabilityToken(files.get('SULLA_API_TOKEN'), key, { category: 'meta', tool: 'ping' });
        expect(proof.tool_session_generation).toBeUndefined();
        await expect(resolver.bindForwarded(worker(), 'clerk_get_user', files.get('SULLA_TOOL_SESSION'),
          { ...proof, request_id: 'fixture' }, new AbortController().signal)).rejects.toThrow('session-bound');
      } finally { host['port'] = port; vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetAgentContainerImageResolution(); }
    });
});

describe('owned lease renewal', () => {
  it('recovers a swept default after 16 minutes without reviving a provider, revoked launcher, or held call', async() => {
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
      await resolver.bindForwarded(held, held.name, a.id, proof, new AbortController().signal);
      await leases.prepare(b.id); b.revoke();
      clock.mockReturnValue(start + 960_000);
      expect(host.peekToolSession(a.id)).toBeNull(); // Sweep before timer callback.
      await renew();
      const fresh = await verifyCapabilityToken(files.get('SULLA_API_TOKEN'), key);
      expect(fresh.tool_session_generation).toBe(host.peekToolSession(a.id)?.executionContext?.jti);
      expect(fresh.tool_session_generation).not.toBe(proof.tool_session_generation);
      expect(host.peekToolSession(b.id)).toBeNull();
      await expect(held['clerkCaller']!.revalidate!()).rejects.toThrow();
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
  it('runs credential-scoped Git status after recovery without delegating the credential', async() => {
    const { registry, parent } = await inventory(true);
    await registry.rehydrate();
    const scoped = { ...parent, scopes: ['github/git_status'], credential_scope: { integration_id: 'github', account_id: 'fixture' } };
    const runtime = registry.forExecution(scoped, 'agent-local')!;
    expect(runtime.podId).toBe(binding.podId);
    const git = new GitStatusWorker();
    git.executionContext = scoped;
    const guest = vi.spyOn(runner, 'runCommand').mockImplementation(async cmd => {
      expect(registry.current()).toBe(runtime);
      return { stdout: cmd.includes('--show-toplevel') ? '/fixture' : cmd.includes('--abbrev-ref') ? 'fixture-branch' : '', stderr: '', exitCode: 0 };
    });
    try {
      const result = await registry.withRuntime(runtime, () => git['_validatedCall']({ absolutePath: '/fixture' }));
      expect(result.successBoolean).toBe(true);
      expect(result.responseString).toContain('Working tree clean');
      expect(() => registry.sessionLeases(runtime)).toThrow('Invalid authority for recovered container');
    } finally { guest.mockRestore(); }
  });

  it.each([
    { scoped: false, caller: 'stale' }, { scoped: true, caller: 'stale' }, { scoped: true, caller: 'absent' },
  ])('runs an ordinary nested CLI with $caller parent (persisted scopes: $scoped)', async({ scoped, caller }) => {
    const { lifecycle, directory, registry, parent } = await inventory(scoped);
    const dir = mkdtempSync(join(tmpdir(), 'cold-lease-'));
    const helper = fileURLToPath(new URL('../../../../../../services/sulla-agent/secret-env.sh', import.meta.url));
    writeFileSync(join(dir, 'SULLA_TOOL_SESSION'), 'old-default');
    edges.spawn.mockImplementation((_cmd, argv: string[]) => {
      const p = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      const target = argv.find(s => s.startsWith(directory + '/LEASE_'));
      if (target) p.stdin.on('data', chunk => writeFileSync(join(dir, target.slice(directory.length + 1)), chunk));
      queueMicrotask(() => p.emit('close', 0)); return p;
    });
    const port = host['port']; host['port'] = 1;
    const running = vi.spyOn(host, 'running', 'get').mockReturnValue(true);
    const guest = vi.spyOn(runner, 'runCommand').mockImplementation(async command => {
      const out = spawnSync('sh', ['-ec', command, 'fixture', helper, dir], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin' } });
      if (out.status !== 0) return { stdout: '', stderr: 'nested CLI wrapper has no process lease', exitCode: 77 };
      const [id, token] = out.stdout.split('\n');
      const proof = await verifyCapabilityToken(token, key, { category: 'meta', tool: 'ping' });
      expect(await clerkAllowed(id)).toBe(false);
      if (caller === 'stale') expect(proof.exp).toBeLessThanOrEqual(parent.exp);
      expect(proof.jti).toBe(lifecycle);
      expect(proof.tool_session_generation).toBeUndefined();
      await expect(resolver.bindForwarded(worker(), 'clerk_get_user', id, { ...proof, request_id: 'child' }, new AbortController().signal))
        .rejects.toMatchObject({ status: 403 });
      await expect(resolver.bindForwarded(worker(), 'clerk_get_user', id, parent, new AbortController().signal))
        .rejects.toMatchObject({ status: 403 });
      return { stdout: 'pong', stderr: '', exitCode: 0 };
    });
    try {
      await registry.rehydrate();
      const recovered = caller === 'stale' ? registry.forExecution(parent, 'agent-local')! : registry.require(parent);
      const release = agentContainerRuntimeRegistry.register(recovered, registry.sessionLeases(recovered));
      try {
        const exec = new ExecWorker(); exec.setState(state);
        const result = await agentContainerRuntimeRegistry.withRuntime(recovered, () => exec['_validatedCall']({
          command: '. "$1"; load_sulla_tool_session "$2"; load_sulla_api_token "$2"; printf "%s\\n%s" "$SULLA_TOOL_SESSION" "$SULLA_API_TOKEN"',
        }));
        expect(result).toMatchObject({ successBoolean: true, responseString: 'pong' });
      } finally { release(); }
    } finally { guest.mockRestore(); running.mockRestore(); host['port'] = port; rmSync(dir, { recursive: true, force: true }); }
  });
});
