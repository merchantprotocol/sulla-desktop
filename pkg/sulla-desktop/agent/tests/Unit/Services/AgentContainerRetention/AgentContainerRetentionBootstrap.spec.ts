// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import type { ContainerRuntimeDriver, ContainerSpec } from '@pkg/runtime/containerRuntime';
import { AgentContainerRetentionBootstrap } from '@pkg/agent/services/AgentContainerRetentionBootstrap';
import { RetentionConfig } from '@pkg/agent/services/AgentContainerRetentionPolicy';

class FailingListRuntime implements ContainerRuntimeDriver {
  listCalls = 0;
  create(_spec: ContainerSpec): Promise<string> { throw new Error('unused') }
  start(): Promise<void> { throw new Error('unused') }
  inspect(): Promise<any> { throw new Error('unused') }
  remove(): Promise<void> { throw new Error('non-agent containers must never be removed') }
  list(): Promise<any[]> { this.listCalls++; return Promise.reject(new Error('docker unavailable')) }
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

describe('AgentContainerRetentionBootstrap', () => {
  it('starts one boot pass, remains idempotent, and disposes the scheduled timer', async() => {
    // risk: multiple boot schedulers race retention or survive app shutdown
    const runtime = new FailingListRuntime();
    const timer = new FakeTimer();
    const bootstrap = new AgentContainerRetentionBootstrap(
      runtime, '/bin/false', timer, { info: () => {}, error: () => {} }, new RetentionConfig({ intervalMs: 123 }),
    );
    bootstrap.start();
    bootstrap.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runtime.listCalls).toBe(1);
    expect(timer.callbacks).toHaveLength(1);
    bootstrap.dispose();
    expect(timer.cleared).toBe(1);
  });
});
