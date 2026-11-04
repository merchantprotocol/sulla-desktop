// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { VaultBrokerError } from '@pkg/vault-broker';
import { DeviceFailureDescriber, DeviceHeartbeatRetrier, type HeartbeatScheduler } from '@pkg/main/deviceHeartbeatPolicy';

class FakeHeartbeatScheduler implements HeartbeatScheduler {
  private callbacks: Array<{ callback: () => void; delayMs: number; handle: ReturnType<typeof setTimeout> }> = [];
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = Symbol(String(delayMs)) as unknown as ReturnType<typeof setTimeout>;
    this.callbacks.push({ callback, delayMs, handle });
    return handle;
  }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void { this.callbacks = this.callbacks.filter(item => item.handle !== handle); }
  runNext(): number {
    const next = this.callbacks.shift();
    if (!next) throw new Error('No scheduled heartbeat retry');
    next.callback();
    return next.delayMs;
  }
}

describe('device heartbeat transient recovery', () => {
  it('retries a sanitized transient broker failure in five seconds and recovers before the cloud offline window', async () => {
    // risk: device availability and credential secrecy
    const scheduler = new FakeHeartbeatScheduler();
    const secret = 'access-token-must-not-leak';
    const error = new VaultBrokerError('upstream_failed', secret, 503, 'connect_ECONNREFUSED', true);
    const detail = new DeviceFailureDescriber().describe(error);
    const logs: string[] = [];
    let attempts = 0;
    const retrier = new DeviceHeartbeatRetrier(scheduler, async() => {
      attempts++;
      if (attempts === 1) {
        logs.push(`[DevicesApi] /devices/heartbeat failed: ${ detail.detail }`);
        return { ok: false, transient: detail.transient };
      }
      logs.push('[DevicesApi] /devices/heartbeat recovered after 1 consecutive failures');
      return { ok: true, transient: false };
    });

    await retrier.run();
    const retryDelay = scheduler.runNext();
    await Promise.resolve();

    expect(retryDelay).toBe(5_000);
    expect(attempts).toBe(2);
    expect(logs[0]).toContain('code=upstream_failed status=503 stage=upstream');
    expect(logs.join('\n')).not.toContain(secret);
    expect(retryDelay).toBeLessThan(120_000);
    expect(logs.at(-1)).toContain('recovered after 1 consecutive failures');
  });
});
