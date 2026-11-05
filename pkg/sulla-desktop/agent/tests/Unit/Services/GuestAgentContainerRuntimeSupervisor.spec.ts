// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ default: { app: { getVersion: () => 'test' } } }));
import type { ContainerRuntimeDriver } from '@pkg/runtime/containerRuntime';
import { GuestAgentContainerRuntimeSupervisor } from '../../../services/AgentContainerLauncher';

const runtime = (inspect: ContainerRuntimeDriver['inspect']): ContainerRuntimeDriver => ({
  list: vi.fn(async() => [{ ID: 'pod-1', Names: 'pod-1' }]), inspect,
} as unknown as ContainerRuntimeDriver);

describe('GuestAgentContainerRuntimeSupervisor', () => {
  it('rehydrates current and upgrade-era labels through durable task identity', async() => {
    // risk: upgrade restart falsely marks a live container task lost
    const current = new GuestAgentContainerRuntimeSupervisor(runtime(async() => ({ Name: '/pod-1', State: { Running: true }, Config: { WorkingDir: '/work', Labels: { 'com.sulla.job-id': 'job-1', 'com.sulla.task-index': '0', 'com.sulla.subject': 'subject-1', 'com.sulla.device-id': 'device-1' } } })));
    expect(await current.liveBindings()).toEqual([expect.objectContaining({ jobId: 'job-1', subject: 'subject-1', deviceId: 'device-1' })]);
    const legacy = new GuestAgentContainerRuntimeSupervisor(runtime(async() => ({ Name: '/pod-1', State: { Status: 'running' }, Config: { WorkingDir: '/work', Labels: { 'com.sulla.workload': 'agent', 'com.sulla.job-id': 'job-1', 'com.sulla.task-index': '0', 'com.sulla.agent-id': 'worker' } } })), {
      resolve: async(jobId, taskIndex) => jobId === 'job-1' && taskIndex === 0 ? { subject: 'legacy-subject', deviceId: 'legacy-device', threadId: 'thread-1' } : undefined,
    });
    expect(await legacy.liveBindings()).toEqual([expect.objectContaining({ jobId: 'job-1', subject: 'legacy-subject', threadId: 'thread-1' })]);
  });

  it('fails closed on inventory rejection and timeout', async() => {
    // risk: failed inventory is mistaken for an empty inventory and live work is lost
    await expect(new GuestAgentContainerRuntimeSupervisor(runtime(async() => { throw new Error('docker unavailable') })).liveBindings()).rejects.toThrow('docker unavailable');
    const hanging = new GuestAgentContainerRuntimeSupervisor(runtime(() => new Promise(() => undefined)), undefined, 5);
    await expect(hanging.liveBindings()).rejects.toThrow('timed out');
  });
});
