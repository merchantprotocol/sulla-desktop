// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import '../../Support/TestHomeEnv';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { BaseThreadState } from '../../../nodes/Graph';
import { deriveCapabilitySigningKey, verifyCapabilityToken } from '@pkg/runtime/capabilityToken';
import { getMCPServerHost } from '@pkg/main/MCPServerHost';
import { ClerkToolSessionResolver } from '@pkg/main/ClerkToolSessionResolver';
import { AgentAwarenessPolicy } from '../../../services/AgentAwarenessPolicy';
import { ClerkWorker } from '../../../tools/clerk/ClerkWorker';
import { createAgentContainerLifecycle, runAgentContainer, resetAgentContainerImageResolution } from '../../../services/AgentContainerLauncher';

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
