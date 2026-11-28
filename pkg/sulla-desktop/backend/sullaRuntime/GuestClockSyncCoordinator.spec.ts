// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  GuestClockSyncCoordinator,
  type GuestClockSyncCoordinatorOptions,
  type GuestClockSyncHostClock,
  type GuestClockSyncLogger,
  type GuestClockSyncPort,
  type GuestClockSyncTimerScheduler,
} from './GuestClockSyncCoordinator.js';

class FakeHostClock implements GuestClockSyncHostClock {
  constructor(public wallMs: number, public monotonicMs = 0) {}

  wallTimeMs(): number {
    return this.wallMs;
  }

  monotonicTimeMs(): number {
    return this.monotonicMs;
  }

  advance(wallDeltaMs: number, monotonicDeltaMs: number): void {
    this.wallMs += wallDeltaMs;
    this.monotonicMs += monotonicDeltaMs;
  }
}

class FakeGuestClock implements GuestClockSyncPort {
  readCount = 0;
  readonly setCalls: number[] = [];
  setError?: Error;
  private nextReadBarrier?: Promise<void>;

  constructor(public epochSeconds: number) {}

  blockNextReadUntil(barrier: Promise<void>): void {
    this.nextReadBarrier = barrier;
  }

  async readEpochSeconds(): Promise<number> {
    this.readCount += 1;
    const barrier = this.nextReadBarrier;

    this.nextReadBarrier = undefined;
    if (barrier) await barrier;

    return this.epochSeconds;
  }

  async setEpochSeconds(epochSeconds: number): Promise<void> {
    this.setCalls.push(epochSeconds);
    if (this.setError) throw this.setError;
    this.epochSeconds = epochSeconds;
  }
}

class FakeTimerScheduler implements GuestClockSyncTimerScheduler {
  private nowMs = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { dueAtMs: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;

    this.timers.set(id, { dueAtMs: this.nowMs + delayMs, callback });

    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingDelays(): number[] {
    return [...this.timers.values()].map(timer => timer.dueAtMs - this.nowMs).sort((left, right) => left - right);
  }

  async advanceBy(durationMs: number): Promise<void> {
    const targetTimeMs = this.nowMs + durationMs;

    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAtMs <= targetTimeMs)
        .sort((left, right) => left[1].dueAtMs - right[1].dueAtMs)[0];

      if (!next) break;
      const [id, timer] = next;

      this.nowMs = timer.dueAtMs;
      this.timers.delete(id);
      timer.callback();
      await this.flushMicrotasks();
    }

    this.nowMs = targetTimeMs;
    await this.flushMicrotasks();
  }

  async flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 12; index++) await Promise.resolve();
  }
}

class FakeLogger implements GuestClockSyncLogger {
  readonly infoLines: string[] = [];
  readonly errorLines: string[] = [];

  info(line: string): void {
    this.infoLines.push(line);
  }

  error(line: string): void {
    this.errorLines.push(line);
  }
}

class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise<void>((resolve) => { this.resolve = resolve; });
  }
}

class GuestClockSyncTestFixture {
  readonly scheduler = new FakeTimerScheduler();
  readonly logger = new FakeLogger();

  constructor(readonly host = new FakeHostClock(1_700_000_000_000), readonly guest = new FakeGuestClock(host.wallMs / 1000)) {}

  coordinator(overrides: Partial<GuestClockSyncCoordinatorOptions> = {}): GuestClockSyncCoordinator {
    return new GuestClockSyncCoordinator({
      hostClock: this.host,
      guestClock: this.guest,
      scheduler: this.scheduler,
      logger: this.logger,
      ...overrides,
    });
  }
}

describe('GuestClockSyncCoordinator', () => {
  // risk: availability — future-dated capability tokens can prevent every guest tool call.
  it('sets a large skew and verifies the corrected guest time', async() => {
    const fixture = new GuestClockSyncTestFixture();

    fixture.guest.epochSeconds -= 75;
    await fixture.coordinator().syncNow('runtime-ready');

    expect(fixture.guest.setCalls).toEqual([fixture.host.wallMs / 1000]);
    expect(fixture.guest.readCount).toBe(2);
    expect(fixture.logger.infoLines).toHaveLength(1);
    expect(fixture.logger.infoLines[0]).toContain('guest clock runtime-ready: skew -75.000s -> 0.000s (corrected)');
  });

  // risk: availability — a guest already within tolerance must not be stepped unnecessarily.
  it('leaves a small skew unchanged', async() => {
    const fixture = new GuestClockSyncTestFixture();

    fixture.guest.epochSeconds += 1.25;
    await fixture.coordinator().syncNow('periodic');

    expect(fixture.guest.setCalls).toHaveLength(0);
    expect(fixture.guest.readCount).toBe(1);
    expect(fixture.logger.infoLines[0]).toContain('guest clock periodic: skew 1.250s -> 1.250s (in sync)');
  });

  // risk: availability — a failed correction must retry at bounded delays and leave an actionable log.
  it('retries a failed set with backoff, then surfaces one logged failure', async() => {
    const fixture = new GuestClockSyncTestFixture();
    const coordinator = fixture.coordinator();
    const underlyingFailure = new Error('date command permission denied');

    fixture.guest.epochSeconds -= 30;
    fixture.guest.setError = underlyingFailure;
    const sync = coordinator.syncNow('runtime-ready');
    const failure = expect(sync).rejects.toThrow('date command permission denied');

    await fixture.scheduler.flushMicrotasks();
    expect(fixture.guest.setCalls).toHaveLength(1);
    expect(fixture.scheduler.pendingDelays()).toEqual([2_000]);
    await fixture.scheduler.advanceBy(1_999);
    expect(fixture.guest.setCalls).toHaveLength(1);
    await fixture.scheduler.advanceBy(1);
    expect(fixture.guest.setCalls).toHaveLength(2);
    expect(fixture.scheduler.pendingDelays()).toEqual([5_000]);
    await fixture.scheduler.advanceBy(5_000);
    expect(fixture.guest.setCalls).toHaveLength(3);
    expect(fixture.scheduler.pendingDelays()).toEqual([15_000]);
    await fixture.scheduler.advanceBy(15_000);
    await failure;

    expect(fixture.guest.setCalls).toHaveLength(4);
    expect(fixture.logger.errorLines).toHaveLength(1);
    expect(fixture.logger.errorLines[0]).toContain('guest clock runtime-ready: skew -30.000s -> unknowns');
    expect(fixture.logger.errorLines[0]).toContain('date command permission denied');
  });

  // risk: availability — resume, timer, and tool-triggered checks must not race separate guest updates.
  it('shares one in-flight sync across concurrent triggers', async() => {
    const fixture = new GuestClockSyncTestFixture();
    const readBarrier = new Deferred();

    fixture.guest.epochSeconds -= 60;
    fixture.guest.blockNextReadUntil(readBarrier.promise);
    const coordinator = fixture.coordinator();
    const resumeSync = coordinator.syncNow('host-resume');
    const onDemandSync = coordinator.syncNow('on-demand');

    expect(onDemandSync).toBe(resumeSync);
    await fixture.scheduler.flushMicrotasks();
    expect(fixture.guest.readCount).toBe(1);

    readBarrier.resolve();
    await resumeSync;

    expect(fixture.guest.readCount).toBe(2);
    expect(fixture.guest.setCalls).toHaveLength(1);
    expect(fixture.logger.infoLines[0]).toContain('guest clock host-resume:');
  });

  // risk: availability — detecting Mac sleep ensures the guest clock is repaired before the next tool call.
  it('treats wall-clock advance without matching monotonic time as host resume', async() => {
    const fixture = new GuestClockSyncTestFixture();
    const coordinator = fixture.coordinator();
    const startEpochSeconds = fixture.host.wallMs / 1000;

    await coordinator.start();

    fixture.host.advance(60_000, 60_000);
    fixture.guest.epochSeconds = fixture.host.wallMs / 1000;
    await fixture.scheduler.advanceBy(60_000);

    fixture.host.advance(300_000, 60_000);
    fixture.guest.epochSeconds = startEpochSeconds + 120;
    await fixture.scheduler.advanceBy(60_000);

    expect(fixture.guest.setCalls).toHaveLength(1);
    expect(fixture.logger.infoLines.some(line => line.includes('guest clock host-resume:') && line.includes('(corrected)'))).toBe(true);

    coordinator.stop();
  });
});
