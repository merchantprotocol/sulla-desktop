// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { NetworkResumeMonitor, type MonitorScheduler, type PowerWakeEvent } from '../networkResumeMonitor';

/** Manual clock: timers fire only when the test advances time. */
class ManualScheduler implements MonitorScheduler {
  private now = 0;
  private timers: Array<{ id: number; due: number; callback: () => void; interval: number | null }> = [];
  private nextId = 1;
  setTimeout(callback: () => void, ms: number): unknown { return this.add(callback, ms, null) }
  clearTimeout(handle: unknown): void { this.timers = this.timers.filter(t => t.id !== handle) }
  setInterval(callback: () => void, ms: number): unknown { return this.add(callback, ms, ms) }
  clearInterval(handle: unknown): void { this.clearTimeout(handle) }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = this.timers.filter(t => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.now = next.due;
      if (next.interval === null) this.timers = this.timers.filter(t => t.id !== next.id);
      else next.due += next.interval;
      next.callback();
    }
    this.now = end;
  }
  pending(): number { return this.timers.length }
  private add(callback: () => void, ms: number, interval: number | null): number {
    const id = this.nextId++;
    this.timers.push({ id, due: this.now + ms, callback, interval });
    return id;
  }
}

class FakeNetwork { online = false; isOnline(): boolean { return this.online } }

class FakePower {
  private listeners = new Map<PowerWakeEvent, Set<() => void>>();
  on(event: PowerWakeEvent, listener: () => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  removeListener(event: PowerWakeEvent, listener: () => void): void { this.listeners.get(event)?.delete(listener) }
  emit(event: PowerWakeEvent): void { for (const l of this.listeners.get(event) ?? []) l() }
  listenerCount(): number { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0) }
}

function setup() {
  const network = new FakeNetwork();
  const power = new FakePower();
  const scheduler = new ManualScheduler();
  const monitor = new NetworkResumeMonitor({ network, power, scheduler, pollMs: 15_000, debounceMs: 3_000 });
  const onOnline = vi.fn();
  monitor.onOnline(onOnline);
  return { network, power, scheduler, monitor, onOnline };
}

describe('NetworkResumeMonitor', () => {
  it('emits one online when connectivity returns, after the debounce', () => {
    // risk: availability — queued edits and backed-off files must resume as soon as the network is back.
    const { network, scheduler, monitor, onOnline } = setup();
    monitor.start();
    network.online = false;
    scheduler.advance(15_000);
    expect(onOnline).not.toHaveBeenCalled();
    network.online = true;
    scheduler.advance(15_000);
    expect(onOnline).not.toHaveBeenCalled();
    scheduler.advance(3_000);
    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of resume, unlock and poll signals into a single online', () => {
    // risk: availability — a wake plus network return in the same moment must not stampede the sync drivers.
    const { network, power, scheduler, monitor, onOnline } = setup();
    network.online = true;
    monitor.start();
    power.emit('resume');
    scheduler.advance(1_000);
    power.emit('unlock-screen');
    scheduler.advance(1_000);
    power.emit('resume');
    scheduler.advance(3_000);
    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it('does not emit online while the machine stays offline, even on resume', () => {
    // risk: privacy — no sync attempt is triggered when there is no network to use.
    const { network, power, scheduler, monitor, onOnline } = setup();
    network.online = false;
    monitor.start();
    power.emit('resume');
    scheduler.advance(60_000);
    expect(onOnline).not.toHaveBeenCalled();
  });

  it('stop removes its power listeners and pending timers, so nothing fires after sign-out', () => {
    // risk: privacy — signed-out sync must not resume.
    const { network, power, scheduler, monitor, onOnline } = setup();
    network.online = true;
    monitor.start();
    power.emit('resume');
    monitor.stop();
    scheduler.advance(60_000);
    expect(onOnline).not.toHaveBeenCalled();
    expect(power.listenerCount()).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });
});
