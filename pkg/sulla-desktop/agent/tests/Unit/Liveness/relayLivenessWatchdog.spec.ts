// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { RelayLivenessWatchdog, type RelayWatchdogScheduler } from '@pkg/main/relayLivenessWatchdog';

class FakeRelayClock implements RelayWatchdogScheduler {
  private time = 0;
  private sequence = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void { this.timers.delete(handle as unknown as number); }
  advanceWithStall(ms: number): void {
    this.time += ms;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.time).sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) if (this.timers.delete(id)) timer.callback();
  }
}

class FakeRelayTransport {
  pings = 0;
  reconnects: string[] = [];
  ping(): void { this.pings++; }
  reconnect(reason: string): void { this.reconnects.push(reason); }
}

const options = { staleSocketMs: 45_000, checkIntervalMs: 15_000, driftThresholdMs: 5_000, pongDeadlineMs: 5_000 };

describe('relay liveness watchdog', () => {
  it('probes after a late callback and does not reconnect when an inbound pong meets the explicit deadline', () => {
    // risk: false disconnect during event-loop stalls
    const clock = new FakeRelayClock();
    const transport = new FakeRelayTransport();
    const warnings: string[] = [];
    const watchdog = new RelayLivenessWatchdog(clock, transport, { info: () => undefined, warn: message => warnings.push(message) }, options);
    watchdog.start();

    clock.advanceWithStall(82_000);
    expect(transport.pings).toBe(1);
    expect(transport.reconnects).toEqual([]);
    expect(warnings[0]).toContain('\"driftMs\":67000');

    watchdog.noteInbound();
    clock.advanceWithStall(5_001);
    expect(transport.reconnects).toEqual([]);
  });

  it('reconnects only when the explicit pong deadline passes without any inbound frame', () => {
    // risk: half-open relay never recovers
    const clock = new FakeRelayClock();
    const transport = new FakeRelayTransport();
    const watchdog = new RelayLivenessWatchdog(clock, transport, { info: () => undefined, warn: () => undefined }, options);
    watchdog.start();

    clock.advanceWithStall(82_000);
    expect(transport.reconnects).toEqual([]);
    clock.advanceWithStall(5_001);

    expect(transport.pings).toBe(1);
    expect(transport.reconnects).toHaveLength(1);
    expect(transport.reconnects[0]).toContain('explicit pong deadline passed');
  });
});
