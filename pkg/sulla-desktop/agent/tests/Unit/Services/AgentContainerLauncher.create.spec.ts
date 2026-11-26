// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ default: { app: { getVersion: () => 'test' } } }));
const guestCommands = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async(importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_command: string, args: string[]) => {
      guestCommands(args);
      return actual.spawn(process.execPath, ['-e', '']);
    },
  };
});
import { createAgentContainer, prepareAgentContainerWorkspace, removeAgentContainer, retireLegacyConversationContainer } from '../../../services/AgentContainerLauncher';

const spec = { name: 'sulla-agent-chat-test-0', image: 'agent-image' } as any;
const oldId = 'a'.repeat(64);
const cleanupCommand = ['exec', '--', 'sh', '-c', expect.stringContaining('/var/lib/sulla/files-fuse/actors/$1'), 'sh', oldId];
beforeEach(() => guestCommands.mockClear());

describe('createAgentContainer', () => {
  it('removes an untracked owned container and retries a name conflict once', async() => {
    // risk: stale --rm cleanup race leaves every new chat turn failing with Docker Conflict
    const runtime = {
      create: vi.fn().mockRejectedValueOnce(new Error('Conflict. The container name is already in use')).mockResolvedValueOnce('new-id'),
      inspect: vi.fn().mockResolvedValue({ Id: oldId, Config: { Labels: { 'com.sulla.workload': 'agent' } } }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as any;
    await expect(createAgentContainer(runtime, spec)).resolves.toBe('new-id');
    expect(runtime.remove).toHaveBeenCalledExactlyOnceWith(oldId, true);
    expect(guestCommands).toHaveBeenCalledExactlyOnceWith(cleanupCommand);
    expect(runtime.remove.mock.invocationCallOrder[0]).toBeLessThan(guestCommands.mock.invocationCallOrder[0]);
    expect(guestCommands.mock.invocationCallOrder[0]).toBeLessThan(runtime.create.mock.invocationCallOrder[1]);
    expect(runtime.create).toHaveBeenCalledTimes(2);
  });

  it('does not remove a container owned by a live lifecycle', async() => {
    // risk: concurrent chat launch deletes the active lifecycle container and kills its turn
    const runtime = {
      create: vi.fn().mockResolvedValueOnce('live-id').mockRejectedValueOnce(new Error('Conflict. name already in use')),
      inspect: vi.fn().mockResolvedValue({ Id: 'live-id', State: { Running: true }, Config: { Labels: { 'com.sulla.workload': 'agent' } } }),
      remove: vi.fn(),
    } as any;
    await createAgentContainer(runtime, { ...spec, name: 'sulla-agent-chat-live-test-0' });
    await expect(createAgentContainer(runtime, { ...spec, name: 'sulla-agent-chat-live-test-0' }))
      .rejects.toMatchObject({ name: 'AgentLaunchError', message: expect.stringMatching(/already using/) });
    expect(runtime.inspect).toHaveBeenCalledTimes(1);
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('never replaces an untracked container whose durable task identity differs', async() => {
    const runtime = {
      create:  vi.fn().mockRejectedValueOnce(new Error('Conflict. name already in use')),
      inspect: vi.fn().mockResolvedValue({ Id: 'other-id', State: { Running: true }, Config: { Labels: {
        'com.sulla.workload': 'agent', 'com.sulla.job-id': 'other-job', 'com.sulla.task-index': '0', 'com.sulla.thread-id': 'other-thread',
      } } }),
      remove: vi.fn(),
    } as any;
    await expect(createAgentContainer(runtime, { ...spec, name: 'sulla-agent-chat-other-task-0', labels: {
      'com.sulla.workload': 'agent', 'com.sulla.job-id': 'job-1', 'com.sulla.task-index': '0', 'com.sulla.thread-id': 'thread-1',
    } })).rejects.toMatchObject({ name: 'AgentLaunchError', message: expect.stringMatching(/safely replace/) });
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('replaces a tracked container that is exited instead of treating it as live', async() => {
    // risk: a dead container permanently blocks new turns for its thread
    const name = 'sulla-agent-chat-exited-test-0';
    const runtime = {
      create: vi.fn().mockResolvedValueOnce('old-id').mockRejectedValueOnce(new Error('Conflict. name already in use'))
        .mockResolvedValueOnce('replacement-id'),
      inspect: vi.fn().mockResolvedValue({ Id: 'old-id', State: { Running: false, Restarting: false }, Config: { Labels: { 'com.sulla.workload': 'agent' } } }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as any;
    await createAgentContainer(runtime, { ...spec, name });
    await expect(createAgentContainer(runtime, { ...spec, name })).resolves.toBe('replacement-id');
    expect(runtime.inspect).toHaveBeenCalledTimes(1);
    expect(runtime.remove).toHaveBeenCalledTimes(1);
    expect(runtime.create).toHaveBeenCalledTimes(3);
  });

  it('clears the live-name marker even when container removal fails', async() => {
    // risk: a transient cleanup failure makes every later turn fail until app restart
    const name = 'sulla-agent-chat-remove-failure-test-0';
    const runtime = {
      create: vi.fn().mockResolvedValueOnce('live-id').mockRejectedValueOnce(new Error('Conflict. name already in use'))
        .mockResolvedValueOnce('replacement-id'),
      inspect: vi.fn().mockResolvedValue({ Id: 'stale-id', Config: { Labels: { 'com.sulla.workload': 'agent' } } }),
      remove: vi.fn().mockRejectedValueOnce(new Error('temporary runtime failure')).mockResolvedValueOnce(undefined),
    } as any;
    await createAgentContainer(runtime, { ...spec, name });
    await expect(removeAgentContainer(runtime, 'live-id', name, 'test', 'test')).rejects.toThrow('temporary runtime failure');
    await expect(createAgentContainer(runtime, { ...spec, name })).resolves.toBe('replacement-id');
    expect(runtime.inspect).toHaveBeenCalledTimes(1);
    expect(runtime.create).toHaveBeenCalledTimes(3);
  });
});

describe('retireLegacyConversationContainer', () => {
  const job = 'chat-legacy-thread';
  const name = `sulla-agent-${ job }-0`;
  const required = { 'com.sulla.workload': 'agent', 'com.sulla.job-id': job, 'com.sulla.task-index': '0' };
  const runtimeFor = (labels: Record<string, string> = required, actualName = name) => ({
    create: vi.fn().mockResolvedValue('live-id'),
    inspect: vi.fn().mockResolvedValue({ Id: oldId, Name: `/${ actualName }`, Config: { Labels: labels } }),
    remove: vi.fn().mockResolvedValue(undefined),
  });

  it('retires the exact upgrade-era container when optional identity labels were absent', async() => {
    const runtime = runtimeFor();
    await expect(retireLegacyConversationContainer(runtime as any, job, 'legacy-thread', 'subject', 'device')).resolves.toBeUndefined();
    expect(runtime.inspect).toHaveBeenCalledExactlyOnceWith(name);
    expect(runtime.remove).toHaveBeenCalledExactlyOnceWith(oldId);
    expect(guestCommands).toHaveBeenCalledExactlyOnceWith(cleanupCommand);
  });

  it.each(['com.sulla.thread-id', 'com.sulla.device-id', 'com.sulla.subject', 'com.sulla.job-id', 'com.sulla.task-index', 'com.sulla.workload'])('rejects a present mismatch in %s', async(label) => {
    const runtime = runtimeFor({ ...required, [label]: 'unrelated' });
    await expect(retireLegacyConversationContainer(runtime as any, job, 'legacy-thread', 'subject', 'device'))
      .rejects.toMatchObject({ name: 'AgentLaunchError', retryable: false });
    expect(runtime.remove).not.toHaveBeenCalled();
    expect(guestCommands).not.toHaveBeenCalled();
  });

  it('rejects a returned container with a different name', async() => {
    const runtime = runtimeFor(required, 'different-name');
    await expect(retireLegacyConversationContainer(runtime as any, job, 'legacy-thread', 'subject', 'device'))
      .rejects.toMatchObject({ name: 'AgentLaunchError', retryable: false });
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('retries a legacy name currently owned by a live Desktop lifecycle', async() => {
    const runtime = runtimeFor();
    await createAgentContainer(runtime as any, { ...spec, name });
    try {
      await expect(retireLegacyConversationContainer(runtime as any, job, 'legacy-thread', 'subject', 'device'))
        .rejects.toMatchObject({ name: 'AgentLaunchError', retryable: true });
      expect(runtime.remove).not.toHaveBeenCalled();
      expect(guestCommands).not.toHaveBeenCalled();
    } finally {
      await removeAgentContainer(runtime as any, 'live-id', name, 'test', 'test');
    }
  });
});

describe('prepareAgentContainerWorkspace', () => {
  const identity = {
    jobId:     'job-1',
    taskIndex: 3,
    threadId:  'worker-thread',
    subject:   'subject',
    deviceId:  'device',
    agentId:   'builder',
    orgId:     'org',
  };

  it('revokes the stale persona lease and removes its Files actor before creating the new chat persona', async() => {
    const { redisClient } = await import('../../../database/RedisClient');
    const revoke = vi.spyOn(redisClient, 'set').mockResolvedValue('OK');
    const name = 'sulla-agent-chat-persona-switch-0';
    const labels = {
      'com.sulla.workload': 'agent', 'com.sulla.job-id': 'chat-persona-switch', 'com.sulla.task-index': '0',
      'com.sulla.thread-id': 'persona-switch', 'com.sulla.subject': 'subject', 'com.sulla.org-id': 'org', 'com.sulla.device-id': 'device',
    };
    const old = { ...labels, 'com.sulla.agent-id': 'persona-a', 'com.sulla.capability-jti': 'old-test-lease' };
    const next = { ...labels, 'com.sulla.agent-id': 'persona-b', 'com.sulla.capability-jti': 'new-test-lease' };
    const runtime = {
      inspect: vi.fn().mockResolvedValue({ Id: oldId, Name: '/' + name, State: { Running: true }, Config: { Labels: old } }),
      create: vi.fn().mockRejectedValueOnce(new Error('Conflict: name in use')).mockResolvedValueOnce('new-id'),
      remove: vi.fn().mockResolvedValue(undefined),
    } as any;
    try {
      await prepareAgentContainerWorkspace(runtime, 'chat', {
        ...identity, jobId: 'chat-persona-switch', taskIndex: 0, threadId: 'persona-switch', agentId: 'persona-b',
      }, undefined, async() => '/workspace');
      await expect(createAgentContainer(runtime, { ...spec, name, labels: next })).resolves.toBe('new-id');
      expect(revoke).toHaveBeenCalledExactlyOnceWith('sulla:capability:revoked:old-test-lease', '1', expect.any(Number));
      expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(runtime.remove.mock.invocationCallOrder[0]);
      expect(runtime.remove).toHaveBeenCalledExactlyOnceWith(oldId, true);
      expect(guestCommands).toHaveBeenCalledExactlyOnceWith(cleanupCommand);
      expect(guestCommands.mock.invocationCallOrder[0]).toBeLessThan(runtime.create.mock.invocationCallOrder[1]);
      expect(runtime.create).toHaveBeenLastCalledWith(expect.objectContaining({ labels: next }));
    } finally {
      revoke.mockRestore();
      await removeAgentContainer(runtime, 'new-id', name, 'test', 'test');
    }
  });

  it('retires legacy and job-scoped survivors before reopening the durable workspace', async() => {
    const events: string[] = [];
    const runtime = {
      inspect: vi.fn((name: string) => {
        events.push(`inspect:${ name }`);
        const jobId = name === 'sulla-agent-chat-worker-thread-0' ? 'chat-worker-thread' : 'job-1';
        const taskIndex = name.endsWith('-0') ? '0' : '3';
        return {
          Id:     `${ taskIndex }`.repeat(64),
          Name:   `/${ name }`,
          Config: {
            Labels: {
              'com.sulla.workload':   'agent',
              'com.sulla.job-id':     jobId,
              'com.sulla.task-index': taskIndex,
              'com.sulla.thread-id':  'worker-thread',
              'com.sulla.subject':    'subject',
              'com.sulla.device-id':  'device',
              'com.sulla.agent-id':   'builder',
              'com.sulla.org-id':     'org',
            },
          },
        };
      }),
      remove: vi.fn((id: string) => { events.push(`remove:${ id[0] }`) }),
    } as any;

    await expect(prepareAgentContainerWorkspace(runtime, 'delegated', identity, 'chat-worker-thread', () => {
      events.push('prepare');
      return Promise.resolve('/durable/workspace');
    })).resolves.toBe('/durable/workspace');

    expect(events).toEqual([
      'inspect:sulla-agent-chat-worker-thread-0', 'remove:0',
      'inspect:sulla-agent-job-1-3', 'remove:3',
      'prepare',
    ]);
    expect(guestCommands).toHaveBeenCalledTimes(2);
  });

  it('leaves the workspace untouched when a stale container identity does not match', async() => {
    const prepare = vi.fn();
    const runtime = {
      inspect: vi.fn((name: string) => ({
        Id:     oldId,
        Name:   `/${ name }`,
        Config: {
          Labels: {
            'com.sulla.workload':   'agent',
            'com.sulla.job-id':     'another-job',
            'com.sulla.task-index': '3',
          },
        },
      })),
      remove: vi.fn(),
    } as any;

    await expect(prepareAgentContainerWorkspace(runtime, 'delegated', identity, undefined, prepare))
      .rejects.toMatchObject({ name: 'AgentLaunchError', retryable: false });
    expect(prepare).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
  });
});
