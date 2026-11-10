// SPDX-License-Identifier: GPL-2.0-or-later
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { NETWORK_POLL_MS, NETWORK_RESUME_DEBOUNCE_MS, NetworkResumeMonitor } from '../networkResumeMonitor';

class FakeClock {
  private now = 0;
  private timers: Array<{ id: number; at: number; fn: () => void; every?: number }> = [];
  private nextId = 1;
  setTimeout(fn: () => void, ms: number): number { return this.add({ fn, at: this.now + ms }) }
  setInterval(fn: () => void, ms: number): number { return this.add({ fn, at: this.now + ms, every: ms }) }
  clearTimeout(id: unknown): void { this.timers = this.timers.filter(t => t.id !== id) }
  clearInterval(id: unknown): void { this.clearTimeout(id) }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      if (due.every) due.at += due.every; else this.timers = this.timers.filter(t => t.id !== due.id);
      due.fn();
    }
    this.now = end;
  }
  pendingCount(): number { return this.timers.length }
  private add(t: { fn: () => void; at: number; every?: number }): number {
    const id = this.nextId++;
    this.timers.push({ id, ...t });
    return id;
  }
}

class FakePower extends EventEmitter {
  on(event: 'resume' | 'unlock-screen', listener: () => void): this { return super.on(event, listener) }
  removeListener(event: 'resume' | 'unlock-screen', listener: () => void): this { return super.removeListener(event, listener) }
}

function setup(initiallyOnline: boolean) {
  const clock = new FakeClock();
  const power = new FakePower();
  let online = initiallyOnline;
  const monitor = new NetworkResumeMonitor({ power, net: { isOnline: () => online }, clock });
  const onOnline = vi.fn();
  monitor.on('online', onOnline);
  return { clock, power, monitor, onOnline, setOnline: (value: boolean) => { online = value } };
}

describe('NetworkResumeMonitor', () => {
  it('emits online once when the network returns, after the poll sees it go down and back up', () => {
    // risk: availability — a laptop that comes back online must push pending edits without a restart.
    const { clock, monitor, onOnline, setOnline } = setup(true);
    monitor.start();
    setOnline(false);
    clock.advance(NETWORK_POLL_MS);
    expect(onOnline).not.toHaveBeenCalled();
    setOnline(true);
    clock.advance(NETWORK_POLL_MS);
    clock.advance(NETWORK_RESUME_DEBOUNCE_MS);
    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of resume and unlock signals into one online event', () => {
    // risk: availability — a wake storm must not trigger a sync storm.
    const { clock, power, monitor, onOnline } = setup(true);
    monitor.start();
    power.emit('resume');
    clock.advance(1_000);
    power.emit('unlock-screen');
    clock.advance(1_000);
    power.emit('resume');
    clock.advance(NETWORK_RESUME_DEBOUNCE_MS - 1);
    expect(onOnline).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it('does not emit online on resume while the network is still down; the poll emits when it returns', () => {
    // risk: availability — waking offline must not report a false reconnect.
    const { clock, power, monitor, onOnline, setOnline } = setup(true);
    monitor.start();
    setOnline(false);
    power.emit('resume');
    clock.advance(NETWORK_RESUME_DEBOUNCE_MS);
    expect(onOnline).not.toHaveBeenCalled();
    setOnline(true);
    clock.advance(NETWORK_POLL_MS + NETWORK_RESUME_DEBOUNCE_MS);
    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it('stop removes power listeners and cancels pending timers so nothing fires afterwards', () => {
    // risk: availability — signing out must not leave a sync wake-up behind.
    const { clock, power, monitor, onOnline } = setup(true);
    monitor.start();
    power.emit('resume');
    monitor.stop();
    clock.advance(NETWORK_RESUME_DEBOUNCE_MS + NETWORK_POLL_MS);
    expect(onOnline).not.toHaveBeenCalled();
    expect(power.listenerCount('resume')).toBe(0);
    expect(clock.pendingCount()).toBe(0);
  });
});
