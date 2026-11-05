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

describe('AgentShutdownController', () => {
  it('disposes rehydration and stops liveness on app quit', async() => {
    // risk: graceful quit leaves timers alive and permits post-quit inventory work
    const { AgentShutdownController } = await import('../../../services/AgentShutdownController');
    const dispose = vi.fn(); const stop = vi.fn(); let quit!: () => void;
    new AgentShutdownController({ dispose }, { stop }).register({ once: (_event, listener) => { quit = listener; } });
    quit();
    expect(dispose).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
  });
});

describe('RuntimeRehydrationCoordinator', () => {
  it('recovers readiness after a rejected inventory without losing live bindings', async() => {
    // risk: transient Docker failure permanently disables fleet reads or marks a live container lost
    const { RuntimeRehydrationCoordinator } = await import('../../../services/RuntimeRehydrationCoordinator');
    const retries: Array<() => void> = []; const inventory = vi.fn()
      .mockRejectedValueOnce(new Error('docker unavailable')).mockResolvedValueOnce(undefined);
    const reconcile = vi.fn(async() => undefined);
    const coordinator = new RuntimeRehydrationCoordinator(inventory, reconcile, { after: (_delay, action) => { retries.push(action); return { cancel: vi.fn() }; } }, 1, 2);
    coordinator.start(); await vi.waitFor(() => expect(retries).toHaveLength(1));
    await expect(coordinator.ready()).rejects.toThrow('runtime inventory pending/retrying: docker unavailable');
    retries.shift()?.(); await vi.waitFor(() => expect(coordinator.isReady()).toBe(true));
    await expect(coordinator.ready()).resolves.toBeUndefined(); expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending retry and never inventories again after disposal', async() => {
    // risk: graceful quit starts Docker work after the app has begun shutting down
    const { RuntimeRehydrationCoordinator } = await import('../../../services/RuntimeRehydrationCoordinator');
    const cancel = vi.fn(); const retries: Array<() => void> = [];
    const inventory = vi.fn().mockRejectedValue(new Error('docker unavailable'));
    const coordinator = new RuntimeRehydrationCoordinator(inventory, async() => undefined, {
      after: (_delay, action) => { retries.push(action); return { cancel }; },
    }, 1, 2);
    coordinator.start(); await vi.waitFor(() => expect(retries).toHaveLength(1));
    coordinator.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    retries[0]();
    await Promise.resolve();
    expect(inventory).toHaveBeenCalledOnce();
  });

  it('does not schedule a retry when inventory rejects after disposal', async() => {
    // risk: a late Docker failure resurrects startup work during graceful quit
    const { RuntimeRehydrationCoordinator } = await import('../../../services/RuntimeRehydrationCoordinator');
    let rejectInventory!: (error: Error) => void;
    const inventory = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectInventory = reject; }));
    const after = vi.fn(() => ({ cancel: vi.fn() }));
    const coordinator = new RuntimeRehydrationCoordinator(inventory, async() => undefined, { after }, 1, 2);
    const running = coordinator.retryNow(); coordinator.dispose(); rejectInventory(new Error('docker unavailable'));
    await running;
    expect(after).not.toHaveBeenCalled();
  });

  it('recovers readiness when a timed-out inventory succeeds on retry', async() => {
    // risk: a hung Docker inspect poisons readiness for the process lifetime
    const { RuntimeRehydrationCoordinator } = await import('../../../services/RuntimeRehydrationCoordinator');
    const retries: Array<() => void> = []; const inventory = vi.fn()
      .mockRejectedValueOnce(new Error('Agent container inventory timed out after 10ms')).mockResolvedValueOnce(undefined);
    const coordinator = new RuntimeRehydrationCoordinator(inventory, async() => undefined, { after: (_delay, action) => { retries.push(action); return { cancel: vi.fn() }; } }, 1, 2);
    coordinator.start(); await vi.waitFor(() => expect(retries).toHaveLength(1)); retries.shift()?.();
    await vi.waitFor(() => expect(coordinator.isReady()).toBe(true)); await expect(coordinator.ready()).resolves.toBeUndefined();
  });
});
