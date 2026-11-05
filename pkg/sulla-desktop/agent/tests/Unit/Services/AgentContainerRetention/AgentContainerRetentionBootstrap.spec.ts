// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import type { ContainerRuntimeDriver, ContainerSpec } from '@pkg/runtime/containerRuntime';
import { AgentContainerRetentionBootstrap } from '@pkg/agent/services/AgentContainerRetentionBootstrap';
import { RetentionConfig } from '@pkg/agent/services/AgentContainerRetentionPolicy';
import { ActiveAgentContainerRegistry } from '@pkg/agent/services/AgentContainerComposition';

class FailingListRuntime implements ContainerRuntimeDriver {
  readonly listFilters: Array<string | undefined> = [];
  create(_spec: ContainerSpec): Promise<string> { throw new Error('unused') }
  start(): Promise<void> { throw new Error('unused') }
  inspect(): Promise<any> { throw new Error('unused') }
  remove(): Promise<void> { throw new Error('non-agent containers must never be removed') }
  list(filter?: string): Promise<any[]> { this.listFilters.push(filter); return Promise.reject(new Error('docker unavailable')) }
}

class FakeTimer {
  callbacks: Array<() => void> = [];
  cleared = 0;
  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    this.callbacks.push(callback);
    return 7 as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(): void { this.cleared++ }
}

class PressuredRuntime implements ContainerRuntimeDriver {
  readonly removed: string[] = [];
  create(_spec: ContainerSpec): Promise<string> { throw new Error('unused') }
  start(): Promise<void> { throw new Error('unused') }
  list(): Promise<any[]> { return Promise.resolve(['active-created', 'old-failed'].map(ID => ({ ID }))) }
  inspect(id: string): Promise<any> {
    return Promise.resolve({ Id: id, Name: `/${ id }`, Created: '2026-11-04T00:00:00.000Z', State: { Status: 'created' }, Config: { Labels: { 'com.sulla.workload': 'agent' } } });
  }
  remove(id: string): Promise<void> { this.removed.push(id); return Promise.resolve() }
}

describe('AgentContainerRetentionBootstrap', () => {
  it('starts one boot pass, remains idempotent, and disposes the scheduled timer', async() => {
    // risk: multiple boot schedulers race retention or survive app shutdown
    const runtime = new FailingListRuntime();
    const timer = new FakeTimer();
    const bootstrap = new AgentContainerRetentionBootstrap(
      runtime, '/bin/false', timer, { info: () => {}, error: () => {} }, { isActive: () => false },
      new RetentionConfig({ intervalMs: 123 }),
    );
    bootstrap.start();
    bootstrap.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runtime.listFilters).toEqual(['com.sulla.owner=agent', 'com.sulla.workload=agent']);
    expect(timer.callbacks).toHaveLength(1);
    bootstrap.dispose();
    expect(timer.cleared).toBe(1);
  });

  it('keeps a grace-expired created container active during launch, then removes it after unregister', async() => {
    // risk: count/disk pressure deletes a container while its pre-start launch work is still running
    const runtime = new PressuredRuntime();
    const timer = new FakeTimer();
    const active = new ActiveAgentContainerRegistry();
    active.register('active-created');
    const bootstrap = new AgentContainerRetentionBootstrap(
      runtime, '/unused', timer, { info: () => {}, error: () => {} }, active,
      new RetentionConfig({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxKept: 0, minFreeDiskBytes: 5, createdGraceMs: 1, intervalMs: 1 }),
      { freeBytes: () => Promise.resolve(0) },
    );
    bootstrap.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runtime.removed).toEqual(['old-failed']);

    active.unregister('active-created');
    timer.callbacks.at(-1)?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runtime.removed).toContain('active-created');
    bootstrap.dispose();
  });
});
