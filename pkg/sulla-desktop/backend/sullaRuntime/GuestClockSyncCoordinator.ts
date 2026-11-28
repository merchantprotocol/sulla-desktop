// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type GuestClockSyncTrigger = 'runtime-ready' | 'host-resume' | 'periodic' | 'on-demand';

export interface GuestClockSyncHostClock {
  wallTimeMs(): number;
  monotonicTimeMs(): number;
}

export interface GuestClockSyncPort {
  readEpochSeconds(): Promise<number>;
  setEpochSeconds(epochSeconds: number): Promise<void>;
}

export interface GuestClockSyncTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GuestClockSyncLogger {
  info(line: string): void;
  error(line: string): void;
}

export interface GuestClockSyncCoordinatorOptions {
  hostClock: GuestClockSyncHostClock;
  guestClock: GuestClockSyncPort;
  scheduler: GuestClockSyncTimerScheduler;
  logger: GuestClockSyncLogger;
  periodicIntervalMs?: number;
  sleepDetectionThresholdMs?: number;
  correctionToleranceSeconds?: number;
  retryDelaysMs?: readonly number[];
  noChangeLogIntervalMs?: number;
}

/** Adapts the host runtime's existing `sulla-runtime exec` command path. */
export class RuntimeCommandGuestClockPort implements GuestClockSyncPort {
  constructor(private readonly runRuntimeCommand: (args: string[]) => Promise<string>) {}

  async readEpochSeconds(): Promise<number> {
    const preciseOutput = (await this.runRuntimeCommand(['exec', '--', '/bin/date', '-u', '+%s.%N'])).trim();
    const preciseEpoch = preciseOutput ? Number(preciseOutput) : Number.NaN;

    if (Number.isFinite(preciseEpoch)) return preciseEpoch;

    // BusyBox builds without %N print it literally; keep their integer-second clock usable.
    const integerOutput = (await this.runRuntimeCommand(['exec', '--', '/bin/date', '-u', '+%s'])).trim();
    const integerEpoch = integerOutput ? Number(integerOutput) : Number.NaN;

    if (!Number.isFinite(integerEpoch)) {
      throw new Error(`Guest date returned an invalid epoch: ${ integerOutput.trim() }`);
    }

    return integerEpoch;
  }

  async setEpochSeconds(epochSeconds: number): Promise<void> {
    await this.runRuntimeCommand(['exec', '--', '/bin/date', '-u', '-s', `@${ Math.floor(epochSeconds) }`]);
  }
}

class GuestClockSyncStoppedError extends Error {}

interface HostClockSample {
  wallTimeMs: number;
  monotonicTimeMs: number;
}

interface GuestClockSkew {
  guestEpochSeconds: number;
  skewSeconds: number;
}

/** Keeps the running guest clock aligned to the host, and verifies every correction. */
export class GuestClockSyncCoordinator {
  static readonly PERIODIC_INTERVAL_MS = 60_000;
  static readonly SLEEP_DETECTION_THRESHOLD_MS = 5_000;
  static readonly CORRECTION_TOLERANCE_SECONDS = 2;
  static readonly RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;
  static readonly NO_CHANGE_LOG_INTERVAL_MS = 10 * 60_000;

  readonly #hostClock: GuestClockSyncHostClock;
  readonly #guestClock: GuestClockSyncPort;
  readonly #scheduler: GuestClockSyncTimerScheduler;
  readonly #logger: GuestClockSyncLogger;
  readonly #periodicIntervalMs: number;
  readonly #sleepDetectionThresholdMs: number;
  readonly #correctionToleranceSeconds: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #noChangeLogIntervalMs: number;
  readonly #scheduledTimers = new Map<unknown, () => void>();
  #started = false;
  #stopped = false;
  #inFlight?: Promise<void>;
  #lastPeriodicSample?: HostClockSample;
  #lastNoChangeLogMonotonicMs?: number;

  constructor(options: GuestClockSyncCoordinatorOptions) {
    this.#hostClock = options.hostClock;
    this.#guestClock = options.guestClock;
    this.#scheduler = options.scheduler;
    this.#logger = options.logger;
    this.#periodicIntervalMs = options.periodicIntervalMs ?? GuestClockSyncCoordinator.PERIODIC_INTERVAL_MS;
    this.#sleepDetectionThresholdMs = options.sleepDetectionThresholdMs ?? GuestClockSyncCoordinator.SLEEP_DETECTION_THRESHOLD_MS;
    this.#correctionToleranceSeconds = options.correctionToleranceSeconds ?? GuestClockSyncCoordinator.CORRECTION_TOLERANCE_SECONDS;
    this.#retryDelaysMs = options.retryDelaysMs ?? GuestClockSyncCoordinator.RETRY_DELAYS_MS;
    this.#noChangeLogIntervalMs = options.noChangeLogIntervalMs ?? GuestClockSyncCoordinator.NO_CHANGE_LOG_INTERVAL_MS;
  }

  /** Starts periodic checks and immediately performs the bounded startup sync. */
  async start(): Promise<void> {
    if (this.#stopped) throw new GuestClockSyncStoppedError('Guest clock sync coordinator has stopped');
    if (this.#started) return this.#inFlight;

    this.#started = true;
    this.#lastPeriodicSample = this.sampleHostClock();
    this.scheduleNextPeriodicCheck();

    return this.syncNow('runtime-ready');
  }

  /** Calls that overlap share the exact same synchronization promise. */
  syncNow(trigger: GuestClockSyncTrigger): Promise<void> {
    if (this.#stopped) return Promise.reject(new GuestClockSyncStoppedError('Guest clock sync coordinator has stopped'));
    if (this.#inFlight) return this.#inFlight;

    let sync: Promise<void>;

    sync = this.synchronizeWithRetries(trigger).finally(() => {
      if (this.#inFlight === sync) this.#inFlight = undefined;
    });
    this.#inFlight = sync;

    return sync;
  }

  /** Stops periodic checks and cancels retry delays without leaving promises hung. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;

    for (const cancel of [...this.#scheduledTimers.values()]) cancel();
    this.#scheduledTimers.clear();
  }

  private async synchronizeWithRetries(trigger: GuestClockSyncTrigger): Promise<void> {
    let initialSkewSeconds: number | undefined;
    let afterSkewSeconds: number | undefined;
    let lastError: unknown;
    const maxAttempts = this.#retryDelaysMs.length + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const shouldRetry = await this.waitBeforeRetry(this.#retryDelaysMs[attempt - 1]);

        if (!shouldRetry) throw new GuestClockSyncStoppedError('Guest clock sync stopped during retry backoff');
      }
      if (this.#stopped) throw new GuestClockSyncStoppedError('Guest clock sync coordinator has stopped');

      afterSkewSeconds = undefined;
      try {
        const before = await this.measureGuestClockSkew();

        if (initialSkewSeconds === undefined) initialSkewSeconds = before.skewSeconds;
        if (Math.abs(before.skewSeconds) <= this.#correctionToleranceSeconds) {
          this.logNoChange(trigger, before.skewSeconds);

          return;
        }

        await this.#guestClock.setEpochSeconds(this.#hostClock.wallTimeMs() / 1000);
        if (this.#stopped) throw new GuestClockSyncStoppedError('Guest clock sync coordinator has stopped');

        const after = await this.measureGuestClockSkew();

        afterSkewSeconds = after.skewSeconds;
        if (Math.abs(after.skewSeconds) > this.#correctionToleranceSeconds) {
          throw new Error(`Verification skew ${ this.formatSeconds(after.skewSeconds) }s exceeds ${ this.#correctionToleranceSeconds }s tolerance`);
        }

        this.#logger.info(`[sulla-runtime] guest clock ${ trigger }: skew ${ this.formatSeconds(before.skewSeconds) }s -> ${ this.formatSeconds(after.skewSeconds) }s (corrected)`);

        return;
      } catch (error) {
        if (error instanceof GuestClockSyncStoppedError || this.#stopped) {
          throw new GuestClockSyncStoppedError('Guest clock sync coordinator has stopped');
        }

        lastError = error;
        if (attempt === maxAttempts - 1) {
          this.logFailure(trigger, initialSkewSeconds, afterSkewSeconds, maxAttempts, error);
          throw error;
        }
      }
    }

    throw lastError;
  }

  private async measureGuestClockSkew(): Promise<GuestClockSkew> {
    const wallTimeBeforeReadMs = this.#hostClock.wallTimeMs();
    const guestEpochSeconds = await this.#guestClock.readEpochSeconds();
    const wallTimeAfterReadMs = this.#hostClock.wallTimeMs();

    if (!Number.isFinite(guestEpochSeconds)) throw new Error('Guest clock returned a non-finite epoch');

    const hostEpochSeconds = (wallTimeBeforeReadMs + wallTimeAfterReadMs) / 2_000;

    return { guestEpochSeconds, skewSeconds: guestEpochSeconds - hostEpochSeconds };
  }

  private logNoChange(trigger: GuestClockSyncTrigger, skewSeconds: number): void {
    const now = this.#hostClock.monotonicTimeMs();

    if (this.#lastNoChangeLogMonotonicMs !== undefined && now - this.#lastNoChangeLogMonotonicMs < this.#noChangeLogIntervalMs) return;
    this.#lastNoChangeLogMonotonicMs = now;
    this.#logger.info(`[sulla-runtime] guest clock ${ trigger }: skew ${ this.formatSeconds(skewSeconds) }s -> ${ this.formatSeconds(skewSeconds) }s (in sync)`);
  }

  private logFailure(
    trigger: GuestClockSyncTrigger, initialSkewSeconds: number | undefined, afterSkewSeconds: number | undefined, attempts: number, error: unknown,
  ): void {
    const underlyingError = error instanceof Error ? `${ error.name}: ${ error.message }` : String(error);
    const safeError = underlyingError.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

    this.#logger.error(`[sulla-runtime] guest clock ${ trigger }: skew ${ this.formatSeconds(initialSkewSeconds) }s -> ${ this.formatSeconds(afterSkewSeconds) }s (failed after ${ attempts } attempts: ${ safeError })`);
  }

  private scheduleNextPeriodicCheck(): void {
    if (!this.#started || this.#stopped) return;

    this.schedule(this.#periodicIntervalMs, () => {
      void this.runPeriodicCheck();
    });
  }

  private async runPeriodicCheck(): Promise<void> {
    try {
      const currentSample = this.sampleHostClock();
      const previousSample = this.#lastPeriodicSample;

      this.#lastPeriodicSample = currentSample;
      let trigger: GuestClockSyncTrigger = 'periodic';

      if (previousSample) {
        const wallElapsedMs = currentSample.wallTimeMs - previousSample.wallTimeMs;
        const monotonicElapsedMs = currentSample.monotonicTimeMs - previousSample.monotonicTimeMs;

        if (wallElapsedMs - monotonicElapsedMs > this.#sleepDetectionThresholdMs) trigger = 'host-resume';
      }

      await this.syncNow(trigger);
    } catch {
      // syncNow logs exhausted retries; timer callbacks must never reject outward.
    } finally {
      this.scheduleNextPeriodicCheck();
    }
  }

  private sampleHostClock(): HostClockSample {
    return { wallTimeMs: this.#hostClock.wallTimeMs(), monotonicTimeMs: this.#hostClock.monotonicTimeMs() };
  }

  private schedule(delayMs: number, callback: () => void, onCancel?: () => void): void {
    let timerHandle: unknown;
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      this.#scheduler.clearTimeout(timerHandle);
      this.#scheduledTimers.delete(timerHandle);
      onCancel?.();
    };

    timerHandle = this.#scheduler.setTimeout(() => {
      if (settled) return;
      settled = true;
      this.#scheduledTimers.delete(timerHandle);
      callback();
    }, delayMs);
    this.#scheduledTimers.set(timerHandle, cancel);
  }

  private waitBeforeRetry(delayMs: number): Promise<boolean> {
    return new Promise(resolve => {
      this.schedule(delayMs, () => resolve(true), () => resolve(false));
    });
  }

  private formatSeconds(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value) ? 'unknown' : value.toFixed(3);
  }
}
